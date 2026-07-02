// The deterministic `lh dev` worktree convention: path and branch are derived purely from
// the PR number (no slug), so any consumer can reconstruct them without a ledger. Keyed by PR
// (not issue, #463) so multiple PRs linked to the same issue get independent worktrees instead
// of colliding on one. Kept in core (not cli/dev.ts) so both the CLI and core/service.ts (e.g.
// `lh resume`) share one source of truth. cli/dev.ts re-exports these for its existing callers/
// tests. See also worktree-prune.ts (prNumberFromBranch) which decodes the same branch convention.
import { join } from "node:path";

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
// issue would collide on the first PR's worktree. `lh dev` no longer creates these, but a
// worktree provisioned before this change may still be on disk, so resume/prune keep
// recognizing it via these helpers rather than orphaning it.

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
