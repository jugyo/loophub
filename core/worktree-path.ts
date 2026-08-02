// The deterministic PR worktree convention: path and branch are derived purely from
// the PR number (no slug), so any consumer can reconstruct them without a ledger. Keyed by PR
// (not issue, #463) so multiple PRs linked to the same issue get independent worktrees instead
// of colliding on one. Kept in core (not cli/dev.ts) so both the CLI and core/service.ts (e.g.
// worktree consumers share one source of truth. cli/dev.ts re-exports these for its existing callers/
// tests. See also worktree-prune.ts (prNumberFromBranch) which decodes the same branch convention.
import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { issueNumberFromBranch } from "./worktree-prune.ts";

export type WorktreeScheme = "pr" | "legacy-issue";

export interface WorktreeIdentity {
  scheme: WorktreeScheme;
  number: number;
}

// Preserve the legacy issue-number convention only when the PR head explicitly identifies it.
// Current and off-convention branches use the PR number so multiple PRs for one issue cannot share
// a worktree.
export function resolveWorktreeIdentity(
  headRef: string | null,
  prNumber: number,
): WorktreeIdentity {
  const legacyIssue = issueNumberFromBranch(headRef);
  if (legacyIssue != null)
    return { scheme: "legacy-issue", number: legacyIssue };
  return { scheme: "pr", number: prNumber };
}

// Prefer the realpath when the target exists so macOS /var → /private/var (and similar
// symlink roots) still compare equal between process.cwd() and a configured worktreeRoot.
function resolvePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Exported for reuse wherever a full_name feeds a derived path or the repos.full_name
// column (worktree paths here, the rename write in core/store.ts).
export function assertSafeRepoSegments(
  fullName: string,
  context: string,
): void {
  for (const seg of fullName.split("/")) {
    // Control characters (NUL etc.) survive path.join but blow up every later fs call on
    // the derived path (ERR_INVALID_ARG_VALUE), so reject them alongside traversal.
    if (
      !seg ||
      seg === "." ||
      seg === ".." ||
      seg.includes("\\") ||
      /[\u0000-\u001f]/.test(seg)
    ) {
      throw new Error(`invalid repo name for ${context}: "${fullName}"`);
    }
  }
}

export function worktreeBranch(pr: number): string {
  return `loophub/pr-${pr}`;
}

// <worktreeRoot>/<owner>/<repo>/pr-<n>. fullName is the repo's "owner/name".
// Guard every segment so a crafted repo name can't traverse out of worktreeRoot.
export function worktreePath(
  worktreeRoot: string,
  fullName: string,
  pr: number,
): string {
  assertSafeRepoSegments(fullName, "worktree path");
  return join(worktreeRoot, fullName, `pr-${pr}`);
}

// ---- legacy (pre-#463) convention ----
//
// Before #463, worktree/branch were keyed by issue number: a second PR opened for the same
// issue would collide on the first PR's worktree. Launchers no longer create these, but a
// worktree provisioned before this change may still be on disk, so maintenance and usage
// attribution keep recognizing it via these helpers rather than orphaning it.

export function legacyWorktreeBranch(issue: number): string {
  return `loophub/issue-${issue}`;
}

export function legacyWorktreePath(
  worktreeRoot: string,
  fullName: string,
  issue: number,
): string {
  assertSafeRepoSegments(fullName, "worktree path");
  return join(worktreeRoot, fullName, `issue-${issue}`);
}

// Reverse of worktreePath (#579 — matching a running herdr agent's cwd back to the PR whose
// worktree it's running in, for the issue-list "Herdr running" badge). Only recognizes the
// current pr-<n> convention directly under <worktreeRoot>/<fullName> — the legacy issue-<n>
// convention is keyed by issue, not PR, and launchers no longer create it, so it's left
// unmatched here (null) rather than resolved to a possibly-stale issue-to-PR link.
const PR_DIR_RE = /^pr-(\d+)$/;

export function pullNumberFromWorktreePath(
  worktreeRoot: string,
  fullName: string,
  checkoutPath: string,
): number | null {
  assertSafeRepoSegments(fullName, "worktree path");
  if (dirname(checkoutPath) !== join(worktreeRoot, fullName)) return null;
  const m = PR_DIR_RE.exec(basename(checkoutPath));
  return m ? Number(m[1]) : null;
}

// Reverse of worktreePath / legacyWorktreePath for CLI repo inference (#1595): recover the
// owner/name encoded in a LoopHub worktree directory under worktreeRoot. Accepts both the
// current pr-<n> leaf and the legacy issue-<n> leaf. Returns null for anything that is not
// exactly <worktreeRoot>/<owner>/<repo>/(pr|issue)-<n> — never guesses from nested or
// unrelated paths. Callers must still confirm the returned full_name is a registered repo.
const WORKTREE_LEAF_RE = /^(?:pr|issue)-\d+$/;

export function fullNameFromWorktreePath(
  worktreeRoot: string,
  checkoutPath: string,
): string | null {
  const root = resolvePath(worktreeRoot);
  const abs = resolvePath(checkoutPath);
  const rel = relative(root, abs);
  if (!rel || rel === "." || isAbsolute(rel) || rel.split(sep).includes("..")) {
    return null;
  }
  const parts = rel.split(sep);
  if (parts.length !== 3) return null;
  const [owner, name, leaf] = parts;
  if (!WORKTREE_LEAF_RE.test(leaf)) return null;
  const fullName = `${owner}/${name}`;
  try {
    assertSafeRepoSegments(fullName, "worktree path");
  } catch {
    return null;
  }
  return fullName;
}
