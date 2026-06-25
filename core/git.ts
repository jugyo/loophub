import { execFile } from "node:child_process";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Run `git -C <repoPath> <args...>` without throwing; we inspect exitCode manually.
export function git(
  repoPath: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", repoPath, ...args],
      {
        env: { ...process.env, ...env },
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

export async function revParse(
  repoPath: string,
  ref: string,
): Promise<string | null> {
  const r = await git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
  const sha = r.stdout.trim();
  return sha || null;
}

export async function defaultBranch(repoPath: string): Promise<string> {
  // Prefer remote default (origin/HEAD) so feature-branch checkouts do not win at registration.
  const origin = await git(repoPath, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (origin.code === 0) {
    const ref = origin.stdout.trim();
    const branch = ref.startsWith("origin/")
      ? ref.slice("origin/".length)
      : ref;
    if (branch && (await revParse(repoPath, branch))) return branch;
  }
  const head = await git(repoPath, ["symbolic-ref", "--short", "HEAD"]);
  return head.stdout.trim() || "main";
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  const r = await git(repoPath, ["rev-parse", "--git-dir"]);
  return r.code === 0;
}

// Absolute path to the shared (common) git directory. For a linked worktree this is the
// primary checkout's `.git` — where objects/refs/logs and the per-worktree gitdir live —
// not the worktree's `.git` pointer file. `lh dev` needs it to grant the sandbox write
// access to the real commit target (see cli/dev.ts buildManagedSettings).
export async function gitCommonDir(repoPath: string): Promise<string> {
  const r = await git(repoPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const p = r.stdout.trim();
  if (r.code !== 0 || !p)
    throw new Error(
      `cannot resolve git common dir for "${repoPath}": ${r.stderr.trim()}`,
    );
  return p;
}

// Absolute path to *this* checkout's git directory. For a linked worktree this is the
// per-worktree `<commonDir>/worktrees/<id>` (where its index, HEAD and per-worktree reflog
// live), not the shared common dir. `lh dev` allows the sandbox to write here.
export async function gitDirOf(repoPath: string): Promise<string> {
  const r = await git(repoPath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  const p = r.stdout.trim();
  if (r.code !== 0 || !p)
    throw new Error(
      `cannot resolve git dir for "${repoPath}": ${r.stderr.trim()}`,
    );
  return p;
}

export interface DiffFile {
  filename: string;
  status: string; // modified | added | removed | renamed
  additions: number;
  deletions: number;
  patch: string;
}

const STATUS_MAP: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "renamed",
  C: "copied",
  T: "changed",
};

// head に固有の差分（merge-base からの変更）= base...head
export async function diffFiles(
  repoPath: string,
  base: string,
  head: string,
): Promise<DiffFile[]> {
  const range = `${base}...${head}`;
  const numstat = await git(repoPath, ["diff", "--numstat", range]);
  const namestatus = await git(repoPath, ["diff", "--name-status", range]);

  const statusByFile: Record<string, string> = {};
  for (const line of namestatus.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0][0];
    const file = parts[parts.length - 1];
    statusByFile[file] = STATUS_MAP[code] ?? "changed";
  }

  const files: DiffFile[] = [];
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split("\t");
    const filename = rest.join("\t");
    const patch = await git(repoPath, ["diff", range, "--", filename]);
    files.push({
      filename,
      status: statusByFile[filename] ?? "modified",
      additions: add === "-" ? 0 : Number(add),
      deletions: del === "-" ? 0 : Number(del),
      patch: stripDiffHeader(patch.stdout),
    });
  }
  return files;
}

function stripDiffHeader(full: string): string {
  // keep from the first @@ hunk onward, like GitHub's "patch" field
  const idx = full.indexOf("\n@@");
  if (idx === -1) return full.trim();
  return full.slice(idx + 1);
}

// Number of commits on head not reachable from base (base..head). 0 means head
// adds nothing over base — a diff-free PR with no commits to merge.
export async function commitsAhead(
  repoPath: string,
  base: string,
  head: string,
): Promise<number> {
  const r = await git(repoPath, ["rev-list", "--count", `${base}..${head}`]);
  return Number(r.stdout.trim()) || 0;
}

export interface MergePreview {
  conflict: boolean;
  tree: string | null;
}

// merge-tree でコンフリクト判定 + 結果ツリー算出（作業ツリー非接触）
export async function mergePreview(
  repoPath: string,
  base: string,
  head: string,
): Promise<MergePreview> {
  const r = await git(repoPath, ["merge-tree", "--write-tree", base, head]);
  const tree = r.stdout.split("\n")[0]?.trim() || null;
  return { conflict: r.code !== 0, tree };
}

export interface MergeResult {
  merged: boolean;
  sha?: string;
  conflict?: boolean;
}

// .git/index.lock 競合は IDE/エディタの Git 連携など他プロセスが同じ checkout を
// 一瞬触ると発生する一過性のエラー。本物の reset 失敗と区別してリトライ対象を絞る。
export function isIndexLockError(stderr: string): boolean {
  return (
    /index\.lock/.test(stderr) &&
    /Unable to create|File exists|another git process/i.test(stderr)
  );
}

export interface MergeOptions {
  resetLockRetries?: number; // index.lock 競合時の reset --hard リトライ回数
  resetLockBackoffMs?: number; // リトライ間バックオフの基準値（attempt ごとに線形増加）
}

const DEFAULT_RESET_LOCK_RETRIES = 5;
const DEFAULT_RESET_LOCK_BACKOFF_MS = 50;

// Sync primary checkout (repoPath) when it is on base. Other linked worktrees are untouched.
async function syncPrimaryCheckoutIfOnBase(
  repoPath: string,
  base: string,
  newSha: string,
  opts: MergeOptions = {},
): Promise<{ needed: boolean; ok: boolean }> {
  const branch = await git(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch.code !== 0) return { needed: false, ok: true };
  if (branch.stdout.trim() !== base) return { needed: false, ok: true };

  const retries = opts.resetLockRetries ?? DEFAULT_RESET_LOCK_RETRIES;
  const backoffMs = opts.resetLockBackoffMs ?? DEFAULT_RESET_LOCK_BACKOFF_MS;

  // index.lock 競合のみ小さなバックオフでリトライ。本物のエラーは即失敗。
  for (let attempt = 0; ; attempt++) {
    const reset = await git(repoPath, ["reset", "--hard", newSha]);
    if (reset.code === 0) return { needed: true, ok: true };
    if (attempt >= retries || !isIndexLockError(reset.stderr)) {
      return { needed: true, ok: false };
    }
    await sleep(backoffMs * (attempt + 1));
  }
}

// Advance base ref without touching other worktrees. Primary checkout on base is synced to newSha.
//   squash => 単一親(base) の 1 コミットに圧縮
//   merge  => 2親(base, head) のマージコミット
//   rebase => head の各コミットを base 上に並べ替え (git replay、線形履歴)
export async function mergePull(
  repoPath: string,
  base: string,
  head: string,
  method: "squash" | "merge" | "rebase",
  message: string,
  actor: string,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  const baseSha = await revParse(repoPath, base);
  const headSha = await revParse(repoPath, head);
  if (!baseSha || !headSha) return { merged: false };

  let newSha: string;

  if (method === "rebase") {
    // git replay は working tree 非接触で「update refs/heads/<head> <new> <old>」を出力。
    // コンフリクト時は exit!=0 かつ出力なし。
    const r = await git(repoPath, [
      "replay",
      "--onto",
      base,
      `${base}..${head}`,
    ]);
    const line = r.stdout.trim().split("\n").pop() || "";
    const parts = line.split(" "); // [update, refs/heads/<head>, <new>, <old>]
    newSha = parts[0] === "update" ? parts[2] : "";
    if (r.code !== 0 || !newSha) return { merged: false, conflict: true };
  } else {
    const preview = await mergePreview(repoPath, base, head);
    if (preview.conflict || !preview.tree)
      return { merged: false, conflict: true };
    const parents =
      method === "merge" ? ["-p", baseSha, "-p", headSha] : ["-p", baseSha];
    const env = {
      GIT_AUTHOR_NAME: actor,
      GIT_AUTHOR_EMAIL: `${actor}@loophub.local`,
      GIT_COMMITTER_NAME: actor,
      GIT_COMMITTER_EMAIL: `${actor}@loophub.local`,
    };
    const commit = await git(
      repoPath,
      ["commit-tree", preview.tree, ...parents, "-m", message],
      env,
    );
    newSha = commit.stdout.trim();
    if (commit.code !== 0 || !newSha) return { merged: false };
  }

  const upd = await git(repoPath, [
    "update-ref",
    `refs/heads/${base}`,
    newSha,
    baseSha,
  ]);
  if (upd.code !== 0) return { merged: false };

  const sync = await syncPrimaryCheckoutIfOnBase(repoPath, base, newSha, opts);
  if (sync.needed && !sync.ok) {
    await git(repoPath, ["update-ref", `refs/heads/${base}`, baseSha, newSha]);
    return { merged: false };
  }

  return { merged: true, sha: newSha };
}

export async function branchExists(
  repoPath: string,
  ref: string,
): Promise<boolean> {
  return (await revParse(repoPath, ref)) !== null;
}

// ---- worktrees ----
//
// Generic git worktree primitives. Higher layers (cli/dev.ts) decide paths and naming;
// these only wrap the git plumbing.

export interface Worktree {
  path: string;
  head: string | null; // commit sha, null for a bare entry
  branch: string | null; // short branch name, null when detached/bare
  bare: boolean;
  detached: boolean;
}

export interface WorktreeAddOptions {
  existingBranch?: boolean; // check out an existing <branch> instead of creating one from <base>
}

// 新規ブランチ: git worktree add -b <branch> <path> <base>
// 既存ブランチ: git worktree add <path> <branch>   (opts.existingBranch)
export async function worktreeAdd(
  repoPath: string,
  path: string,
  branch: string,
  base: string,
  opts: WorktreeAddOptions = {},
): Promise<void> {
  const args = opts.existingBranch
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, base];
  const r = await git(repoPath, args);
  if (r.code !== 0) {
    throw new Error(
      `git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

// git worktree remove <path>. Without --force git refuses a dirty or locked worktree, which
// is an extra safety net on top of the caller's clean-tree guard; callers must have verified
// the tree is clean and the branch matches the loophub/issue-<n> convention before calling.
export async function worktreeRemove(
  repoPath: string,
  path: string,
): Promise<void> {
  const r = await git(repoPath, ["worktree", "remove", path]);
  if (r.code !== 0) {
    throw new Error(
      `git worktree remove failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

// git worktree prune: drop stale administrative entries (gitDir/worktrees/<id>) for worktrees
// whose directories are already gone. Idempotent and safe — never touches a live worktree.
export async function worktreePrune(repoPath: string): Promise<void> {
  await git(repoPath, ["worktree", "prune"]);
}

// Porcelain status of a checkout, used for the clean-tree guard before removal. Callers inspect
// both `code` and `stdout` (a non-zero exit means we could not verify cleanliness → treat dirty).
export async function worktreeStatus(path: string): Promise<GitResult> {
  return git(path, ["status", "--porcelain", "--untracked-files=normal"]);
}

// git worktree list --porcelain をパース。
export async function worktreeList(repoPath: string): Promise<Worktree[]> {
  const r = await git(repoPath, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return [];
  return parseWorktreePorcelain(r.stdout);
}

function parseWorktreePorcelain(out: string): Worktree[] {
  const wts: Worktree[] = [];
  let cur: Worktree | null = null;
  const flush = () => {
    if (cur) wts.push(cur);
    cur = null;
  };
  for (const line of out.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      flush();
      cur = {
        path: val,
        head: null,
        branch: null,
        bare: false,
        detached: false,
      };
    } else if (!cur) {
    } else if (key === "HEAD") {
      cur.head = val;
    } else if (key === "branch") {
      cur.branch = val.startsWith("refs/heads/")
        ? val.slice("refs/heads/".length)
        : val;
    } else if (key === "bare") {
      cur.bare = true;
    } else if (key === "detached") {
      cur.detached = true;
    }
  }
  flush();
  return wts;
}
