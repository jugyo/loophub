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

export async function mergeBase(
  repoPath: string,
  base: string,
  head: string,
): Promise<string | null> {
  const r = await git(repoPath, ["merge-base", base, head]);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
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

// Fetch URL of a remote (default origin), or null when the remote/URL is unset. Used to decide a
// repo's default merge mode (#406): a GitHub remote defaults the PR detail to "Create PR on GitHub".
export async function remoteUrl(
  repoPath: string,
  remote = "origin",
): Promise<string | null> {
  const r = await git(repoPath, ["remote", "get-url", remote]);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  const r = await git(repoPath, ["rev-parse", "--git-dir"]);
  return r.code === 0;
}

// Absolute path to the shared (common) git directory. For a linked worktree this is the
// primary checkout's `.git` — where objects/refs/logs and the per-worktree gitdir live —
// not the worktree's `.git` pointer file. A linked worktree's commit writes into this shared
// common dir (objects/refs/logs), so callers that need to reason about the real commit target
// resolve it here rather than trusting the worktree's `.git` pointer file.
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
// live), not the shared common dir. Agent launchers allow the sandbox to write here.
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
  previousFilename?: string;
  headFilename?: string;
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
  return diffFilesForRevisions(repoPath, [`${base}...${head}`]);
}

/** Files changed by one commit compared with its first parent. */
export async function commitDiffFiles(
  repoPath: string,
  sha: string,
): Promise<DiffFile[]> {
  return diffFilesForRevisions(repoPath, [`${sha}^`, sha]);
}

/** Whether an exact full commit SHA belongs to base..head. */
export async function commitInRange(
  repoPath: string,
  base: string,
  head: string,
  sha: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/i.test(sha)) return false;
  const commits = await git(repoPath, ["rev-list", `${base}..${head}`]);
  assertGitSuccess(commits, "git rev-list failed");
  const normalizedSha = sha.toLowerCase();
  return commits.stdout
    .split("\n")
    .some((commit) => commit.trim().toLowerCase() === normalizedSha);
}

async function diffFilesForRevisions(
  repoPath: string,
  revisions: string[],
): Promise<DiffFile[]> {
  const numstat = await git(repoPath, ["diff", "--numstat", ...revisions]);
  const numstatZ = await git(repoPath, [
    "diff",
    "--numstat",
    "-z",
    ...revisions,
  ]);
  const namestatus = await git(repoPath, [
    "diff",
    "--name-status",
    "-z",
    ...revisions,
  ]);
  assertGitSuccess(numstat, "git diff --numstat failed");
  assertGitSuccess(numstatZ, "git diff --numstat -z failed");
  assertGitSuccess(namestatus, "git diff --name-status failed");
  const statusByFile = parseNameStatusZ(namestatus.stdout);

  const structured = parseNumstatZ(numstatZ.stdout);
  const files: DiffFile[] = [];
  for (const [index, line] of numstat.stdout.split("\n").entries()) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split("\t");
    const filename = rest.join("\t");
    const paths = structured[index];
    const headFilename = paths?.headFilename ?? paths?.filename ?? filename;
    const displayFilename = paths?.previousFilename
      ? filename
      : (paths?.filename ?? filename);
    const status =
      statusByFile[headFilename] ?? statusByFile[displayFilename] ?? "modified";
    const patchPaths =
      paths?.previousFilename && status === "renamed"
        ? [paths.previousFilename, headFilename]
        : [headFilename];
    const patch = await git(repoPath, [
      "diff",
      ...revisions,
      "--",
      ...patchPaths,
    ]);
    assertGitSuccess(patch, "git diff patch failed");
    files.push({
      filename: displayFilename,
      previousFilename: paths?.previousFilename,
      headFilename,
      status,
      additions: add === "-" ? 0 : Number(add),
      deletions: del === "-" ? 0 : Number(del),
      patch: stripDiffHeader(patch.stdout),
    });
  }
  return files;
}

function assertGitSuccess(result: GitResult, context: string): void {
  if (result.code === 0) return;
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `git exited with code ${result.code}`;
  throw new Error(`${context}: ${detail}`);
}

function parseNameStatusZ(stdout: string): Record<string, string> {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const statusByFile: Record<string, string> = {};
  for (let i = 0; i < fields.length; ) {
    const statusField = fields[i++];
    if (!statusField) continue;
    const code = statusField[0];
    const status = STATUS_MAP[code] ?? "changed";
    if (code === "R" || code === "C") {
      i += 1; // previous path
      const headFilename = fields[i++];
      if (headFilename) statusByFile[headFilename] = status;
      continue;
    }
    const filename = fields[i++];
    if (filename) statusByFile[filename] = status;
  }
  return statusByFile;
}

function parseNumstatZ(stdout: string): Array<{
  filename: string;
  previousFilename?: string;
  headFilename?: string;
}> {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: Array<{
    filename: string;
    previousFilename?: string;
    headFilename?: string;
  }> = [];
  for (let i = 0; i < fields.length; i++) {
    const [add, del, ...pathParts] = fields[i].split("\t");
    const path = pathParts.join("\t");
    if (add == null || del == null || pathParts.length === 0) continue;
    if (path === "") {
      const previousFilename = fields[++i];
      const headFilename = fields[++i];
      if (previousFilename && headFilename) {
        files.push({
          filename: headFilename,
          previousFilename,
          headFilename,
        });
      }
      continue;
    }
    files.push({ filename: path, headFilename: path });
  }
  return files;
}

export interface DiffStat {
  additions: number;
  deletions: number;
  changedFiles: number;
}

// Aggregate +/- line counts and changed-file count for base...head with a
// single numstat (no per-file patch fetch). Binary files report "-" for both
// columns: they count as a changed file but add 0 to the line totals.
export async function diffStat(
  repoPath: string,
  base: string,
  head: string,
): Promise<DiffStat> {
  const range = `${base}...${head}`;
  const numstat = await git(repoPath, ["diff", "--numstat", range]);
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [add, del] = line.split("\t");
    additions += add === "-" ? 0 : Number(add) || 0;
    deletions += del === "-" ? 0 : Number(del) || 0;
    changedFiles += 1;
  }
  return { additions, deletions, changedFiles };
}

function stripDiffHeader(full: string): string {
  // keep from the first @@ hunk onward, like GitHub's "patch" field
  const idx = full.indexOf("\n@@");
  if (idx === -1) return full.trim();
  return full.slice(idx + 1);
}

export interface FileAtRef {
  status: "ok" | "missing" | "binary";
  content?: string;
}

// Full text of `path` as it existed at `ref` (`git show <ref>:<path>`), for whole-file preview
// (e.g. rendering Markdown) rather than a unified diff. "missing" covers both an added file
// (absent from base) and a deleted file (absent from head); "binary" flags content with an
// embedded NUL byte so callers can skip trying to render it as text.
export async function fileAtRef(
  repoPath: string,
  ref: string,
  path: string,
): Promise<FileAtRef> {
  const r = await git(repoPath, ["show", `${ref}:${path}`]);
  if (r.code !== 0) return { status: "missing" };
  if (r.stdout.includes("\0")) return { status: "binary" };
  return { status: "ok", content: r.stdout };
}

// Whether `path` is one of the files changed in base...head — an exact-string membership check
// against the full changed-file list (cheap, unlike diffFiles() which computes every changed
// file's full patch), used to keep fileAtRef() from being callable as a general "read any tracked
// file at any commit" primitive. Deliberately does NOT pass `path` as a `--` pathspec: git
// pathspecs support wildcards and `:(...)` magic (e.g. `:(exclude)...`) that can match every
// changed file without `path` actually being one of them, which would defeat this check.
export async function pathInDiff(
  repoPath: string,
  base: string,
  head: string,
  path: string,
): Promise<boolean> {
  const r = await git(repoPath, ["diff", "--name-only", `${base}...${head}`]);
  return r.stdout.split("\n").some((line) => line === path);
}

// Whether base...head has an effective diff — at least one changed file in the
// three-dot range. Unlike commitsAhead (two-dot commit count), a branch with
// commits ahead of base whose net changes cancel out (add then revert) reports
// false: there is nothing to merge (#1243). Deliberately mirrors pathInDiff's
// `diff --name-only base...head`; kept separate from diffStat, which returns 0
// on error (zero-on-error would misclassify a real diff as empty).
export async function hasEffectiveDiff(
  repoPath: string,
  base: string,
  head: string,
): Promise<boolean> {
  const r = await git(repoPath, ["diff", "--name-only", `${base}...${head}`]);
  return r.stdout.split("\n").some((line) => line !== "");
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

export interface CommitInfo {
  sha: string;
  author: string;
  date: string; // committer date, ISO 8601
  subject: string;
}

// Commits on head not reachable from base (base..head), newest first. Bounded by `limit`
// so a long-lived branch can't return an unbounded log into the debug view. Fields are
// separated by US (0x1f) and records by RS (0x1e) so subjects with tabs/newlines stay intact.
export async function commitLog(
  repoPath: string,
  base: string,
  head: string,
  limit = 100,
): Promise<CommitInfo[]> {
  const r = await git(repoPath, [
    "log",
    `--max-count=${limit}`,
    "--format=%H%x1f%an%x1f%cI%x1f%s%x1e",
    `${base}..${head}`,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `git log failed for ${base}..${head}: ${r.stderr.trim() || "unknown error"}`,
    );
  }
  return r.stdout
    .split("\x1e")
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [sha, author, date, subject] = rec.split("\x1f");
      return { sha, author, date, subject: subject ?? "" };
    });
}

// Return the PR commits known to have reached GitHub through `pushedSha`. A stored SHA is trusted
// only while it is still part of the current base..head history; after a rebase or other history
// rewrite, returning null keeps callers from presenting an unverifiable commit as pushed.
export async function pushedCommitShas(
  repoPath: string,
  base: string,
  head: string,
  pushedSha: string,
): Promise<Set<string> | null> {
  if (!/^[0-9a-f]{40}$/i.test(pushedSha)) return null;

  const current = await git(repoPath, ["rev-list", `${base}..${head}`]);
  assertGitSuccess(current, "git rev-list failed");
  const currentShas = new Set(
    current.stdout
      .split("\n")
      .map((sha) => sha.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!currentShas.has(pushedSha.toLowerCase())) return null;

  const pushed = await git(repoPath, ["rev-list", `${base}..${pushedSha}`]);
  assertGitSuccess(pushed, "git rev-list failed");
  return new Set(
    pushed.stdout
      .split("\n")
      .map((sha) => sha.trim().toLowerCase())
      .filter(Boolean),
  );
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
  const conflictTree = tree && /^[0-9a-f]{40,64}$/u.test(tree);
  if (r.code !== 0 && (r.code !== 1 || !conflictTree)) {
    const detail = r.stderr.trim();
    throw new Error(
      detail ? `git merge-tree failed: ${detail}` : "git merge-tree failed",
    );
  }
  return { conflict: r.code === 1, tree };
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

export interface WorktreeRemoveOptions {
  force?: boolean;
}

// git worktree remove <path>. Without --force git refuses a dirty or locked worktree, which
// is an extra safety net on top of the caller's clean-tree guard. With force, callers must have
// explicitly authorized discarding changes and still verified the managed-worktree invariant.
export async function worktreeRemove(
  repoPath: string,
  path: string,
  opts: WorktreeRemoveOptions = {},
): Promise<void> {
  const args = opts.force
    ? ["worktree", "remove", "--force", path]
    : ["worktree", "remove", path];
  const r = await git(repoPath, args);
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

// Like worktreeList, but a git failure is reported instead of read as "no worktrees" —
// for callers whose safety decision depends on actually seeing the list (#485: the rename
// guard must refuse, not proceed, when local_path is gone or the repo is corrupt).
export async function worktreeListChecked(
  repoPath: string,
): Promise<{ ok: true; worktrees: Worktree[] } | { ok: false; error: string }> {
  const r = await git(repoPath, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0)
    return { ok: false, error: r.stderr.trim() || `git exited ${r.code}` };
  return { ok: true, worktrees: parseWorktreePorcelain(r.stdout) };
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
