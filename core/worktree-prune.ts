// Pure classification + clean-tree logic for `lh worktree prune` (cli/index.ts). Kept free of
// git/DB side effects so the guard and the keep/remove/skip decision are unit-testable in
// isolation; the CLI layer feeds it the resolved issue/PR state, dirtiness and cwd flag.

// Legacy (pre-#463) branch convention: loophub/issue-<n> (see core/worktree-path.ts
// legacyWorktreeBranch). Launchers no longer create these, but a worktree provisioned before
// #463 may still be on disk, so prune must keep recognizing it.
const LEGACY_LOOPHUB_BRANCH_RE = /^loophub\/issue-(\d+)$/;

// Current (#463+) branch convention: loophub/pr-<n> (see core/worktree-path.ts worktreeBranch).
const LOOPHUB_PR_BRANCH_RE = /^loophub\/pr-(\d+)$/;

// Issue number for a legacy LoopHub-managed branch, or null for anything off that convention
// (the primary checkout's default branch, ad-hoc worktrees, or the current pr-<n> convention).
export function issueNumberFromBranch(branch: string | null): number | null {
  if (!branch) return null;
  const m = LEGACY_LOOPHUB_BRANCH_RE.exec(branch);
  return m ? Number(m[1]) : null;
}

// PR number for a current-convention LoopHub-managed branch, or null for anything off that
// convention (the primary checkout's default branch, ad-hoc worktrees, or a legacy issue-<n>
// branch — see issueNumberFromBranch).
export function prNumberFromBranch(branch: string | null): number | null {
  if (!branch) return null;
  const m = LOOPHUB_PR_BRANCH_RE.exec(branch);
  return m ? Number(m[1]) : null;
}

// `.claude/` is mirrored into every worktree by provisionWorktree (syncClaudeDir) and is
// not gitignored, so `git status --porcelain --untracked-files=normal` always reports it as an
// untracked entry. It is LoopHub-injected, never user work, so it must not count toward the
// clean-tree guard — otherwise every worktree would look dirty and prune would skip them all.
function isInjectedArtifact(path: string): boolean {
  return path === ".claude/" || path.startsWith(".claude/");
}

// True when the worktree has real uncommitted/untracked changes worth preserving. Input is the
// raw `git status --porcelain` stdout; the LoopHub-injected `.claude/` artifact is filtered out.
export function porcelainIsDirty(porcelain: string): boolean {
  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const path = line.slice(3); // strip the two-char "XY " status prefix (porcelain v1)
    if (!path) continue; // malformed/short line with no path → nothing to preserve
    if (isInjectedArtifact(path)) continue;
    return true;
  }
  return false;
}

export type PruneAction = "remove" | "keep" | "skip";

export interface ClassifyInput {
  isCwd: boolean; // the worktree is the current working directory (git would refuse to remove it)
  dirty: boolean; // real uncommitted/untracked changes (see porcelainIsDirty)
  force?: boolean; // explicitly allow dirty worktrees to become removal candidates
  issueState: "open" | "closed" | null; // null = issue not found in LoopHub for this branch
  prMerged: boolean; // a linked PR exists and is merged
  prState: "open" | "closed" | null; // linked PR state, null when there is no linked PR
}

export interface Classification {
  action: PruneAction;
  reason: string;
}

// Decide what to do with a single LoopHub worktree. The cwd guard always wins; the dirty guard
// wins unless force explicitly disables it. A worktree is a removal candidate only when its
// issue is closed or its PR is merged.
export function classifyWorktree(input: ClassifyInput): Classification {
  if (input.isCwd)
    return { action: "skip", reason: "current working directory" };
  if (input.dirty && !input.force)
    return { action: "skip", reason: "uncommitted or untracked changes" };
  if (input.prMerged) return { action: "remove", reason: "PR merged" };
  if (input.issueState === "closed")
    return { action: "remove", reason: "issue closed" };
  if (input.issueState === null)
    return { action: "keep", reason: "issue not found in LoopHub" };
  return { action: "keep", reason: "issue open, PR not merged" };
}

// #1837: the worker only auto-prunes a finished worktree once this long after the merge/close, so
// a human still has a full day to inspect or resume from the checkout. `lh worktree prune` stays
// available for removing it sooner.
export const WORKTREE_AUTO_PRUNE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface DoneAtInput {
  prMerged: boolean; // a linked PR exists and is merged
  prMergedAt: string | null; // that PR's merge timestamp
  issueState: "open" | "closed" | null; // null = issue not found in LoopHub for this branch
  issueClosedAt: string | null; // the row's close timestamp
}

// The completion timestamp behind classifyWorktree's "remove" verdict, or null when the worktree
// is not finished. Precedence mirrors classifyWorktree: a merged PR wins over a closed issue.
export function worktreeDoneAt(input: DoneAtInput): string | null {
  if (input.prMerged) return input.prMergedAt;
  if (input.issueState === "closed") return input.issueClosedAt;
  return null;
}

// True when `doneAt` is a real timestamp at least `graceMs` in the past. A missing or unparsable
// timestamp is never eligible: an unattended sweep must not remove a worktree whose completion
// time it cannot confirm, even though classifyWorktree already called it done.
export function autoPruneGraceElapsed(
  doneAt: string | null,
  nowMs: number,
  graceMs: number = WORKTREE_AUTO_PRUNE_GRACE_MS,
): boolean {
  if (!doneAt) return false;
  const parsed = Date.parse(doneAt);
  if (!Number.isFinite(parsed)) return false;
  return nowMs - parsed >= graceMs;
}
