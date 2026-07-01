// Pure, side-effect-free decision for a PR's mergeable state. Kept separate from
// serialize.ts (which gathers the git/DB signals) so the classification is
// reusable and unit-testable without spawning git or opening the DB.

export type MergeableState =
  | "clean" // has commits, no conflict, all review topics passed — actually mergeable
  | "conflict" // conflicts with base
  | "no_commits" // base and head have no difference (nothing to merge)
  | "blocked" // mergeable tree but reviews not yet complete or a topic has unresolved changes
  | "unknown"; // not computed (merged PR, or head/base sha missing)

export interface MergeableSignals {
  /** Head has at least one commit not in base (i.e. base..head is non-empty). */
  hasCommits: boolean;
  /** Merging head into base conflicts. */
  conflict: boolean;
  /** At least one review topic has a substantive review (reviews are gathered). */
  reviewed: boolean;
  /** Every reviewed topic's latest substantive review passes (no unresolved REQUEST_CHANGES). */
  allTopicsPassed: boolean;
}

export interface MergeableDecision {
  mergeable: boolean | null;
  mergeable_state: MergeableState;
}

/**
 * Decide whether a PR is mergeable from its raw signals (#427). A PR is
 * `mergeable: true` (state `clean`) only when it has commits, merges cleanly,
 * has at least one review gathered (`reviewed`), and every *reviewed* topic
 * passed (`allTopicsPassed` — no unresolved REQUEST_CHANGES / stale pass on
 * any aspect that was reviewed). The merge gate is no longer a single PASS:
 * a PR with no reviews yet stays `blocked` rather than falling to `clean` just
 * because nothing requested changes. Note the gate does not require any specific
 * aspect to be present — there is no required-topic registry (out of scope for
 * #427), so it only aggregates topics that actually have reviews. A diff-free PR
 * is `no_commits`, a conflicting one `conflict`, and any remaining not-yet-passed
 * PR is `blocked`. `no_commits` is checked first because a diff-free tree can
 * never conflict.
 */
export function resolveMergeable(signals: MergeableSignals): MergeableDecision {
  if (!signals.hasCommits)
    return { mergeable: false, mergeable_state: "no_commits" };
  if (signals.conflict)
    return { mergeable: false, mergeable_state: "conflict" };
  if (!signals.reviewed || !signals.allTopicsPassed)
    return { mergeable: false, mergeable_state: "blocked" };
  return { mergeable: true, mergeable_state: "clean" };
}
