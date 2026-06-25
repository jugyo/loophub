// The deterministic `lh dev` worktree convention: path and branch are derived purely from
// the issue number (no slug), so any consumer can reconstruct them without a ledger. Kept in
// core (not cli/dev.ts) so both the CLI and core/service.ts (e.g. `lh resume`) share one source
// of truth. cli/dev.ts re-exports these for its existing callers/tests. See also
// worktree-prune.ts (issueNumberFromBranch) which decodes the same branch convention.
import { join } from "node:path";

export function worktreeBranch(issue: number): string {
  return `loophub/issue-${issue}`;
}

// <worktreeRoot>/<owner>/<repo>/issue-<n>. fullName is the repo's "owner/name".
// Guard every segment so a crafted repo name can't traverse out of worktreeRoot.
export function worktreePath(
  worktreeRoot: string,
  fullName: string,
  issue: number,
): string {
  for (const seg of fullName.split("/")) {
    if (!seg || seg === "." || seg === ".." || seg.includes("\\")) {
      throw new Error(`invalid repo name for worktree path: "${fullName}"`);
    }
  }
  return join(worktreeRoot, fullName, `issue-${issue}`);
}
