import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run an exact git argv synchronously without throwing on a non-zero exit. */
export function runGitSync(
  args: string[],
  env: Record<string, string> = {},
): GitResult {
  const argv = ["git", ...args];
  const result = spawnSync(argv[0], argv.slice(1), {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// Run `git -C <repoPath> <args...>` without throwing; we inspect exitCode manually.
export function git(
  repoPath: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<GitResult> {
  return spawnGit(repoPath, args, env);
}

function spawnGit(
  repoPath: string,
  args: string[],
  env: Record<string, string>,
): Promise<GitResult> {
  const argv = ["git", "-C", repoPath, ...args];
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
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

// Qualify a local branch name for use as a git revision. A bare name goes through git's ambiguous
// ref resolution (gitrevisions(7)), where `$GIT_DIR/<name>` — and then tags and remote-tracking
// refs — are consulted before `refs/heads/<name>`: a stray `.git/<branch-name>` file (#12) silently
// shadows the branch the caller meant and resolves to whatever SHA it holds. The primitives below
// stay generic (they also take SHAs and already-qualified refs), so callers holding a name they
// know to be a local branch qualify it here, right before handing it to git.
export function localBranchRef(name: string): string {
  if (name.startsWith("refs/heads/")) return name;
  return `refs/heads/${name}`;
}

export async function revParse(
  repoPath: string,
  ref: string,
): Promise<string | null> {
  const r = await git(repoPath, ["rev-parse", "--verify", "--quiet", ref]);
  const sha = r.stdout.trim();
  return sha || null;
}

export async function isShallowRepository(repoPath: string): Promise<boolean> {
  const r = await git(repoPath, ["rev-parse", "--is-shallow-repository"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

// Human-facing diagnosis when a local branch tip cannot be resolved for merge plumbing.
// Surfaces collision candidates (`$GIT_DIR/<name>` pseudo-refs, `refs/heads/<name>`, tags) and a
// fix hint so operators can recover (#39 AC: not only throw, but say what collided and how to fix).
export async function describeUnresolvedRevision(
  repoPath: string,
  rev: string,
): Promise<string> {
  const lines: string[] = [`could not resolve revision '${rev}'`];
  const bare = bareRevisionName(rev);
  if (!bare) return lines.join("\n");

  const candidates: string[] = [];
  try {
    const commonDir = await gitCommonDir(repoPath);
    const pseudoPath = join(commonDir, bare);
    if (existsSync(pseudoPath)) {
      let preview = "";
      try {
        preview = readFileSync(pseudoPath, "utf8").trim().slice(0, 40);
      } catch {
        // unreadable pseudo-ref still counts as a collision candidate
      }
      candidates.push(
        preview
          ? `$GIT_DIR/${bare} (stray file, content ${preview})`
          : `$GIT_DIR/${bare} (stray file)`,
      );
    }
  } catch {
    // common-dir lookup can fail for non-repos; still report heads/tags below
  }

  const headSha = await revParse(repoPath, `refs/heads/${bare}`);
  if (headSha) candidates.push(`refs/heads/${bare} → ${headSha}`);
  const tagSha = await revParse(repoPath, `refs/tags/${bare}`);
  if (tagSha) candidates.push(`refs/tags/${bare} → ${tagSha}`);

  if (candidates.length > 0) {
    lines.push("candidates:");
    for (const c of candidates) lines.push(`  - ${c}`);
  }
  lines.push(
    `hint: pass refs/heads/${bare} (or its commit SHA), or remove a stray $GIT_DIR/${bare} file if it is not a real ref`,
  );
  return lines.join("\n");
}

// Symbolic / special revisions that live as `$GIT_DIR/<name>` for real, not as collision
// pseudo-refs. Diagnosing them as "stray files" would point operators at HEAD itself.
const SPECIAL_REVISIONS = new Set([
  "HEAD",
  "FETCH_HEAD",
  "ORIG_HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REBASE_HEAD",
  "REVERT_HEAD",
  "AUTO_MERGE",
]);

// Bare branch-ish name for collision diagnosis. Full SHAs and non-heads refs stay opaque.
// Branch names may contain `/` (e.g. loophub/pr-1); reject only empty tokens, NULs, absolute
// paths, and `..` so diagnosis never probes outside `$GIT_DIR`.
function bareRevisionName(rev: string): string | null {
  if (/^[0-9a-f]{40,64}$/i.test(rev)) return null;
  if (rev.startsWith("refs/heads/")) {
    const name = rev.slice("refs/heads/".length);
    return name &&
      !name.includes("\0") &&
      !name.includes("..") &&
      !name.startsWith("/")
      ? name
      : null;
  }
  if (rev.startsWith("refs/")) return null;
  if (!rev || rev.includes("\0") || rev.startsWith("/") || rev.includes("..")) {
    return null;
  }
  if (SPECIAL_REVISIONS.has(rev)) return null;
  return rev;
}

export async function mergeBase(
  repoPath: string,
  base: string,
  head: string,
): Promise<string | null> {
  return mergeBaseWithEnv(repoPath, base, head);
}

// Retry ancestry traversal without honoring the repository's shallow boundary. This never fetches
// or mutates the repository; it only exposes parent objects that are already present locally.
export async function mergeBaseIgnoringShallow(
  repoPath: string,
  base: string,
  head: string,
): Promise<string | null> {
  return mergeBaseWithEnv(repoPath, base, head, { GIT_SHALLOW_FILE: "" });
}

async function mergeBaseWithEnv(
  repoPath: string,
  base: string,
  head: string,
  env: Record<string, string> = {},
): Promise<string | null> {
  const r = await git(repoPath, ["merge-base", base, head], env);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/** True when `ancestor` is an ancestor of `descendant` (inclusive). */
export async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const r = await git(repoPath, [
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ]);
  return r.code === 0;
}

export async function isAncestorIgnoringShallow(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const r = await git(
    repoPath,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { GIT_SHALLOW_FILE: "" },
  );
  return r.code === 0;
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

// Short name of the checked-out branch, or null on a detached HEAD. Callers that compare a checkout
// against a remote (#71) have nothing to compare in the detached case, so they report "no branch"
// rather than guessing one from the commit.
export async function currentBranch(repoPath: string): Promise<string | null> {
  const r = await git(repoPath, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

export interface AheadBehind {
  ahead: number; // commits on `ref` that `upstream` does not have
  behind: number; // commits on `upstream` that `ref` does not have
}

// The ahead/behind pair `git status` reports for a tracking branch, counted from the merge base of
// `ref` and `upstream`. Null when either revision cannot be resolved — a branch that was never
// pushed has no `refs/remotes/<remote>/<branch>` — so callers can distinguish "no counts to show"
// from a genuine 0/0.
export async function aheadBehind(
  repoPath: string,
  ref: string,
  upstream: string,
): Promise<AheadBehind | null> {
  const r = await git(repoPath, [
    "rev-list",
    "--left-right",
    "--count",
    `${upstream}...${ref}`,
  ]);
  if (r.code !== 0) return null;
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return null;
  return { ahead, behind };
}

// `git pull --ff-only <remote> <branch>` in a checkout. Fast-forward only on purpose: when the
// local branch has diverged, git refuses with its own message instead of writing a merge commit
// into the human's checkout, and the caller surfaces that message. The remote and branch are named
// explicitly so a branch without tracking configuration still pulls the branch being displayed.
export async function pullFastForward(
  repoPath: string,
  branch: string,
  remote = "origin",
): Promise<GitResult> {
  return git(repoPath, ["pull", "--ff-only", remote, branch]);
}

// `git fetch <remote>` in a checkout. Quiet on purpose — fetch output is progress noise the caller
// does not show, and only a failure matters. Unlike pullFastForward, fetch never touches the
// working tree or the checked-out branch, so it is safe on a detached HEAD; it only moves the
// remote-tracking refs under `refs/remotes/<remote>/`.
export async function fetchRemote(
  repoPath: string,
  remote = "origin",
): Promise<GitResult> {
  return git(repoPath, ["fetch", "--quiet", remote]);
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

/** What a changed file is, without the text of the change. */
export interface DiffFileSummary {
  filename: string;
  previousFilename?: string;
  headFilename?: string;
  status: string; // modified | added | removed | renamed
  additions: number;
  deletions: number;
}

export interface DiffFile extends DiffFileSummary {
  patch: string;
}

export interface DiffOptions {
  ignoreWhitespace?: boolean;
  /** Limit the diff to these exact paths — matched literally, so a name git itself printed cannot
   *  be re-read as pathspec magic. Pass every path a file is known by, so that a rename still
   *  pairs its two sides instead of reading as a delete and an add. */
  paths?: string[];
}

const STATUS_MAP: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "renamed",
  C: "copied",
  T: "changed",
};

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// head に固有の差分（merge-base からの変更）= base...head
export async function diffFiles(
  repoPath: string,
  base: string,
  head: string,
  options: DiffOptions = {},
): Promise<DiffFile[]> {
  return diffFilesForRevisions(repoPath, [`${base}...${head}`], options);
}

/** Files changed between an exact, persisted base/head commit pair. */
export async function diffFilesBetween(
  repoPath: string,
  baseSha: string,
  headSha: string,
  options: DiffOptions = {},
): Promise<DiffFile[]> {
  return diffFilesForRevisions(repoPath, [baseSha, headSha], options);
}

/**
 * The files changed between an exact base/head commit pair, without their patches.
 *
 * One `git diff --raw --numstat -z` instead of the three runs `diffFilesBetween` makes: a caller
 * that only needs to know which files changed — and how they are named on each side — should not
 * pay for the whole PR's patch text, which is seconds on a large diff (#120).
 */
export async function diffFileSummariesBetween(
  repoPath: string,
  baseSha: string,
  headSha: string,
  options: DiffOptions = {},
): Promise<DiffFileSummary[]> {
  return diffFileSummariesForRevisions(repoPath, [baseSha, headSha], options);
}

/** Files changed by one commit compared with its first parent. */
export async function commitDiffFiles(
  repoPath: string,
  sha: string,
): Promise<DiffFile[]> {
  const commit = await git(repoPath, ["rev-list", "--parents", sha]);
  assertGitSuccess(commit, "git rev-list failed");
  const [, parent] = commit.stdout.trim().split(/\s+/);
  const base = parent ?? EMPTY_TREE_SHA;
  return diffFilesForRevisions(repoPath, [base, sha]);
}

function diffArgs(options: DiffOptions): {
  whitespaceArgs: string[];
  pathspecArgs: string[];
} {
  return {
    whitespaceArgs: options.ignoreWhitespace ? ["--ignore-all-space"] : [],
    pathspecArgs: options.paths?.length
      ? ["--", ...options.paths.map((path) => `:(literal)${path}`)]
      : [],
  };
}

async function diffFileSummariesForRevisions(
  repoPath: string,
  revisions: string[],
  options: DiffOptions = {},
): Promise<DiffFileSummary[]> {
  const { whitespaceArgs, pathspecArgs } = diffArgs(options);
  const metadata = await git(repoPath, [
    "diff",
    ...whitespaceArgs,
    "--raw",
    "--numstat",
    "-z",
    ...revisions,
    ...pathspecArgs,
  ]);
  assertGitSuccess(metadata, "git diff --raw --numstat -z failed");
  const { statusByFile, structured } = parseRawNumstatZ(metadata.stdout);
  return structured.map((paths) => {
    const headFilename = paths.headFilename ?? paths.filename;
    const displayFilename = paths?.previousFilename
      ? `${paths.previousFilename} => ${headFilename}`
      : paths.filename;
    return {
      filename: displayFilename,
      previousFilename: paths?.previousFilename,
      headFilename,
      status:
        statusByFile[headFilename] ??
        statusByFile[displayFilename] ??
        "modified",
      additions: paths.additions,
      deletions: paths.deletions,
    };
  });
}

async function diffFilesForRevisions(
  repoPath: string,
  revisions: string[],
  options: DiffOptions = {},
): Promise<DiffFile[]> {
  const { whitespaceArgs, pathspecArgs } = diffArgs(options);
  const summaries = await diffFileSummariesForRevisions(
    repoPath,
    revisions,
    options,
  );
  const [patch, addedPatch] = await Promise.all([
    git(repoPath, ["diff", ...whitespaceArgs, ...revisions, ...pathspecArgs]),
    git(repoPath, [
      "diff",
      ...whitespaceArgs,
      "--no-renames",
      "--diff-filter=A",
      ...revisions,
      ...pathspecArgs,
    ]),
  ]);
  assertGitSuccess(patch, "git diff patch failed");
  assertGitSuccess(addedPatch, "git diff added-file patch failed");
  const patches = splitDiffPatches(patch.stdout);
  const addedPatches = splitDiffPatches(addedPatch.stdout);
  const addedPatchByFile = new Map(
    addedPatches.flatMap((filePatch) => {
      const path = patchHeadPath(filePatch);
      return path ? [[path, filePatch] as const] : [];
    }),
  );

  return summaries.map((summary, index) => {
    const headFilename = summary.headFilename ?? summary.filename;
    const originalPatch = stripDiffHeader(patches[index] ?? "");
    const copyTargetPatch = stripDiffHeader(
      addedPatchByFile.get(headFilename) ?? "",
    );
    const filePatch =
      summary.status === "copied" &&
      !originalPatch.includes("@@") &&
      copyTargetPatch.includes("@@")
        ? `${originalPatch}\n${copyTargetPatch}`
        : originalPatch;
    return { ...summary, patch: filePatch };
  });
}

function parseRawNumstatZ(stdout: string): {
  statusByFile: Record<string, string>;
  structured: ReturnType<typeof parseNumstatZ>;
} {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const statusByFile: Record<string, string> = {};
  let index = 0;
  while (fields[index]?.startsWith(":")) {
    const metadata = fields[index++];
    const statusField = metadata.trim().split(/\s+/).at(-1) ?? "";
    const code = statusField[0];
    const status = STATUS_MAP[code] ?? "changed";
    const firstPath = fields[index++];
    const headFilename =
      code === "R" || code === "C" ? fields[index++] : firstPath;
    if (headFilename) statusByFile[headFilename] = status;
  }
  return {
    statusByFile,
    structured: parseNumstatZ(`${fields.slice(index).join("\0")}\0`),
  };
}

function assertGitSuccess(result: GitResult, context: string): void {
  if (result.code === 0) return;
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `git exited with code ${result.code}`;
  throw new Error(`${context}: ${detail}`);
}

function parseNumstatZ(stdout: string): Array<{
  filename: string;
  previousFilename?: string;
  headFilename?: string;
  additions: number;
  deletions: number;
}> {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: Array<{
    filename: string;
    previousFilename?: string;
    headFilename?: string;
    additions: number;
    deletions: number;
  }> = [];
  for (let i = 0; i < fields.length; i++) {
    const [add, del, ...pathParts] = fields[i].split("\t");
    const path = pathParts.join("\t");
    if (add == null || del == null || pathParts.length === 0) continue;
    const additions = add === "-" ? 0 : Number(add);
    const deletions = del === "-" ? 0 : Number(del);
    if (path === "") {
      const previousFilename = fields[++i];
      const headFilename = fields[++i];
      if (previousFilename && headFilename) {
        files.push({
          filename: headFilename,
          previousFilename,
          headFilename,
          additions,
          deletions,
        });
      }
      continue;
    }
    files.push({
      filename: path,
      headFilename: path,
      additions,
      deletions,
    });
  }
  return files;
}

function splitDiffPatches(stdout: string): string[] {
  if (!stdout) return [];
  const starts: number[] = [];
  if (stdout.startsWith("diff --git ")) starts.push(0);
  let offset = 0;
  while (true) {
    const index = stdout.indexOf("\ndiff --git ", offset);
    if (index === -1) break;
    starts.push(index + 1);
    offset = index + 1;
  }
  return starts.map((start, index) =>
    stdout.slice(start, starts[index + 1] ?? stdout.length),
  );
}

function patchHeadPath(patch: string): string | null {
  const header = patch.split("\n").find((line) => line.startsWith("+++ "));
  if (!header) return null;
  const path = decodeGitPath(header.slice(4));
  return path.startsWith("b/") ? path.slice(2) : path;
}

function decodeGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  for (let index = 1; index < path.length - 1; index += 1) {
    const char = path[index];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const escaped = path[++index];
    const simple: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    if (escaped in simple) {
      bytes.push(simple[escaped]);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(path[index + 1] ?? "")) {
        octal += path[++index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    bytes.push(...Buffer.from(escaped));
  }
  return Buffer.from(bytes).toString("utf8");
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

export interface CommitLogOptions {
  // Bounds a long-lived branch so it can't return an unbounded log into the debug view.
  limit?: number;
  // Exclude commits reachable from another view of the same base branch, such as a
  // remote-tracking ref or a base view the head absorbed before a rewrite.
  additionalBases?: string[];
  // Follow only each merge's first parent, i.e. list what this branch did on its own line and
  // treat everything it merged in as someone else's work (#98). Base branches get rewritten
  // under a long-lived PR, and every rewritten view the head merged is unreachable from the
  // current base tip, so no fixed set of `--not` bases can name them all — but they all arrive
  // through a merge's second parent, which is exactly what this skips.
  firstParentOnly?: boolean;
}

/** The newest PR commit that changed one file: its sha and committer date. */
export interface LastChangedCommit {
  sha: string;
  date: string;
}

/**
 * The newest PR commit that changed each file, keyed by its path at that commit. One log walk
 * covers the whole PR, and first-parent traversal matches the commit list's definition of which
 * commits belong to the PR. The sha names the version a reader saw, so a file marked viewed can be
 * compared against it later (#2502).
 */
export async function lastChangedCommitsByFile(
  repoPath: string,
  baseShas: string[],
  head: string,
): Promise<Record<string, LastChangedCommit>> {
  const r = await git(repoPath, [
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    "--find-renames",
    "--format=%x1e%H%x1f%cI%x00",
    "--name-only",
    "-z",
    head,
    "--not",
    ...baseShas,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `git log failed for ${baseShas.join(", ")}..${head}: ${r.stderr.trim() || "unknown error"}`,
    );
  }

  const commits: Record<string, LastChangedCommit> = {};
  for (const record of r.stdout.split("\x1e").slice(1)) {
    const headerEnd = record.indexOf("\0");
    if (headerEnd < 0) continue;
    const [sha, date] = record.slice(0, headerEnd).split("\x1f");
    if (!sha || !date) continue;
    const paths = record
      .slice(headerEnd + 1)
      .replace(/^\0\n/, "")
      .split("\0")
      .filter((path) => path !== "");
    for (const path of paths) commits[path] ??= { sha, date };
  }
  return commits;
}

// Commits on head not reachable from base (base..head), newest first. Fields are separated by
// US (0x1f) and records by RS (0x1e) so subjects with tabs/newlines stay intact.
export async function commitLog(
  repoPath: string,
  base: string,
  head: string,
  opts: CommitLogOptions = {},
): Promise<CommitInfo[]> {
  const { limit = 100, additionalBases = [], firstParentOnly = false } = opts;
  const r = await git(repoPath, [
    "log",
    `--max-count=${limit}`,
    ...(firstParentOnly ? ["--first-parent"] : []),
    "--format=%H%x1f%an%x1f%cI%x1f%s%x1e",
    head,
    "--not",
    base,
    ...additionalBases,
  ]);
  if (r.code !== 0) {
    throw new Error(
      `git log failed for ${[base, ...additionalBases].join(", ")}..${head}: ${r.stderr.trim() || "unknown error"}`,
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
//
// Callers that hold local branch names should pass `localBranchRef(name)` (or a resolved SHA)
// rather than a bare name: git's ambiguous-ref chain prefers `$GIT_DIR/<name>` over
// `refs/heads/<name>`, and a stray file there makes merge-tree fail with "refname is ambiguous"
// (#12 / #39).
export async function mergePreview(
  repoPath: string,
  base: string,
  head: string,
): Promise<MergePreview> {
  let r = await git(repoPath, ["merge-tree", "--write-tree", base, head]);
  // A shallow boundary can make two related commits look unrelated even when every parent object
  // needed for the merge is already present locally through another ref. Retry that one failure
  // without the boundary; Git still fails visibly if any required object is actually missing.
  if (
    r.code !== 0 &&
    r.stderr.includes("refusing to merge unrelated histories") &&
    (await isShallowRepository(repoPath))
  ) {
    r = await git(repoPath, ["merge-tree", "--write-tree", base, head], {
      GIT_SHALLOW_FILE: "",
    });
  }
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
  // Why the merge did not happen, when reporting it as a plain conflict would mislead: a rebase
  // refuses a branch it cannot replay even though nothing conflicts. Callers present it instead of
  // their own wording, so it reads as a sentence.
  reason?: string;
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

// Head's commits cannot be replayed as one line of history: a merge commit's content belongs to
// two lineages at once, and no replayed commit carries both.
const UNREPLAYABLE_MERGE =
  "Rebase cannot replay this branch's merge commits; merge or squash instead";

// Replay head's commits onto base as a linear history. `sha` is the replayed tip, or null with the
// conflict this hit — `reason` set when nothing actually conflicts and the branch is simply not
// replayable. No working tree is touched.
//
// One `git replay --onto` call used to do this, but replay is EXPERIMENTAL and its interface
// moved: since git 2.53 it defaults to `--ref-action=update`, updating the replayed refs itself
// and printing nothing, so the "update <ref> <new> <old>" line this code parsed is gone. The
// merge then reported a conflict while head's branch had already been rewritten. Older git
// (before replay existed at all) failed the same path for a different reason. merge-tree and
// commit-tree — the same plumbing the merge and squash paths use — behave the same way on every
// git version that LoopHub already requires.
//
// Each replayed commit's tree is base's tip merged with that commit, i.e. base plus the changes
// that commit's own ancestry carries; chaining every commit onto the previous one keeps per-commit
// diffs intact. Authors are carried over; the committer is left to git's own identity resolution,
// exactly as replay left it.
//
// Merge commits are skipped, which reproduces head only while head's own commits form a single
// line — including the common shape where head merged base in to stay current. When head merged a
// side branch, or resolved a merge by hand, the last replayed commit holds one lineage and not the
// other, so the replayed tip would be a tree head never had. Comparing that tip against the tree a
// merge of head produces catches exactly those cases, and they are refused rather than landed.
// This is not a capability lost in the move off replay: replay itself refused every merge-carrying
// head ("replaying merge commits is not supported yet"). Flattening them the way `git rebase` does
// needs a per-commit merge base (`merge-tree --merge-base`, git 2.40+), which this path — running
// on `merge-tree --write-tree` alone since git 2.38 — deliberately does not require.
async function replayOntoBase(
  repoPath: string,
  base: string,
  baseSha: string,
  head: string,
): Promise<{ sha: string | null; reason?: string }> {
  // Oldest first, parents before children whatever the commit dates say. One call carries every
  // field a replayed commit needs, so only the merge and the commit itself cost a process.
  const list = await git(repoPath, [
    "log",
    "--reverse",
    "--topo-order",
    "--no-merges",
    "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e",
    `${base}..${head}`,
  ]);
  if (list.code !== 0)
    throw new Error(
      `git log failed for ${base}..${head}: ${list.stderr.trim()}`,
    );

  let onto = baseSha;
  for (const record of list.stdout.split("\x1e")) {
    const fields = record.replace(/^\n/, "");
    if (!fields.trim()) continue;
    const [sha, name, email, date, body] = fields.split("\x1f");
    const preview = await mergePreview(repoPath, baseSha, sha);
    if (preview.conflict || !preview.tree) return { sha: null };
    const commit = await git(
      repoPath,
      ["commit-tree", preview.tree, "-p", onto, "-m", body.replace(/\n+$/, "")],
      {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
      },
    );
    const replayed = commit.stdout.trim();
    if (commit.code !== 0 || !replayed)
      throw new Error(`git commit-tree failed: ${commit.stderr.trim()}`);
    onto = replayed;
  }

  const whole = await mergePreview(repoPath, base, head);
  if (whole.conflict || !whole.tree) return { sha: null };
  const tree = await git(repoPath, ["rev-parse", `${onto}^{tree}`]);
  if (tree.code !== 0)
    throw new Error(`git rev-parse failed for ${onto}: ${tree.stderr.trim()}`);
  return tree.stdout.trim() === whole.tree
    ? { sha: onto }
    : { sha: null, reason: UNREPLAYABLE_MERGE };
}

// Advance base ref without touching other worktrees. Primary checkout on base is synced to newSha.
//   squash => 単一親(base) の 1 コミットに圧縮
//   merge  => 2親(base, head) のマージコミット
//   rebase => head の各コミットを base 上に並べ替え (線形履歴)
export type PullMergeMethod = "squash" | "merge" | "rebase";

export async function mergePull(
  repoPath: string,
  base: string,
  head: string,
  method: PullMergeMethod,
  message: string,
  // Author/committer for the commit this merge creates. A named actor identifies the agent
  // session that merged; `null` means "nobody in particular", and leaves git's own identity
  // resolution (repository, then global, then git's auto-detection) in place instead of
  // stamping a placeholder name into history (#2389). The rebase path always resolves this
  // way: it keeps each replayed commit's own author and never stamps an actor.
  actor: string | null,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  // `base`/`head` are local branch names — this function updates `refs/heads/<base>` and compares
  // `base` against the checked-out branch below — so every revision handed to git is qualified
  // rather than left to ambiguous ref resolution (#12).
  const baseRev = localBranchRef(base);
  const headRev = localBranchRef(head);
  const baseSha = await revParse(repoPath, baseRev);
  const headSha = await revParse(repoPath, headRev);
  if (!baseSha || !headSha) return { merged: false };

  let newSha: string;

  if (method === "rebase") {
    const replayed = await replayOntoBase(repoPath, baseRev, baseSha, headRev);
    if (!replayed.sha)
      return { merged: false, conflict: true, reason: replayed.reason };
    newSha = replayed.sha;
  } else {
    const preview = await mergePreview(repoPath, baseRev, headRev);
    if (preview.conflict || !preview.tree)
      return { merged: false, conflict: true };
    const parents =
      method === "merge" ? ["-p", baseSha, "-p", headSha] : ["-p", baseSha];
    // Without an actor the env stays empty, so commit-tree reads user.name / user.email the way
    // any other git command would. When git cannot determine an identity at all it fails, and the
    // merge fails visibly rather than falling back to a made-up author.
    const env: Record<string, string> = actor
      ? {
          GIT_AUTHOR_NAME: actor,
          GIT_AUTHOR_EMAIL: `${actor}@loophub.local`,
          GIT_COMMITTER_NAME: actor,
          GIT_COMMITTER_EMAIL: `${actor}@loophub.local`,
        }
      : {};
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
