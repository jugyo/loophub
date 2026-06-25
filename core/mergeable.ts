// Pure, side-effect-free decision for a PR's mergeable state. Kept separate from
// serialize.ts (which gathers the git/DB signals) so the classification is
// reusable and unit-testable without spawning git or opening the DB.

export type MergeableState =
  | "clean" // has commits, no conflict, approved — actually mergeable
  | "dirty" // conflicts with base
  | "no_commits" // base and head have no difference (nothing to merge)
  | "blocked" // mergeable tree but not yet approved
  | "unknown"; // not computed (merged PR, or head/base sha missing)

export interface MergeableSignals {
  /** Head has at least one commit not in base (i.e. base..head is non-empty). */
  hasCommits: boolean;
  /** Merging head into base conflicts. */
  conflict: boolean;
  /** Review state is APPROVED. */
  approved: boolean;
}

export interface MergeableDecision {
  mergeable: boolean | null;
  mergeable_state: MergeableState;
}

/**
 * Decide whether a PR is mergeable from its raw signals. Only an approved PR
 * that has commits and merges cleanly is `mergeable: true` (state `clean`).
 * A diff-free PR is `no_commits`, an unapproved one `blocked`, and a conflicting
 * one keeps the existing `dirty` behaviour. `no_commits` is checked first because
 * a diff-free tree can never conflict.
 */
export function resolveMergeable(signals: MergeableSignals): MergeableDecision {
  if (!signals.hasCommits)
    return { mergeable: false, mergeable_state: "no_commits" };
  if (signals.conflict) return { mergeable: false, mergeable_state: "dirty" };
  if (!signals.approved)
    return { mergeable: false, mergeable_state: "blocked" };
  return { mergeable: true, mergeable_state: "clean" };
}
