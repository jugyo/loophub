import { localBranchRef, revParse } from "./git.ts";
import type { MergeableState } from "./mergeable.ts";
import { resolveMergeable } from "./mergeable.ts";
import { pullShaStatus } from "./pull-status-cache.ts";
import * as S from "./store.ts";

// Compute one open PR's current mergeable_state from live git + review signals, reusing the same
// pure classifier serialize.ts's mergePreview path feeds (#427). Shared by the merge-ready
// notification sweep and the conflict sweep so both read a single definition of "what state is
// this PR in now" instead of each re-deriving it (#1232).
//
// #2364: both sweeps run over *every* open PR in every repo — the merge-ready one on each read of
// the notification badge, which an idle browser tab refetches on any event — so the git side asks
// for the SHA pair rather than passing the refs through. The pair is already resolved here for the
// review gate, and going through it means an idle tab reuses the same entry the PR list rendered
// instead of respawning merge-tree per PR per poll.
export async function currentMergeableState(
  pull: S.OpenPullSweepRow,
): Promise<MergeableState> {
  return (await currentPullStatus(pull))?.mergeable_state ?? "unknown";
}

export async function currentPullStatus(pull: S.OpenPullSweepRow): Promise<{
  baseSha: string;
  headSha: string;
  mergeable: boolean | null;
  mergeable_state: MergeableState;
  hasEffectiveDiff: boolean;
  conflict: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitsAhead: number;
} | null> {
  const [headSha, baseSha] = await Promise.all([
    revParse(pull.local_path, localBranchRef(pull.head_ref)),
    revParse(pull.local_path, localBranchRef(pull.base_ref)),
  ]);
  if (!headSha || !baseSha) return null;

  const status = await pullShaStatus(pull.local_path, baseSha, headSha);
  const reviewGate = S.computeReviewGate(pull.issue_id, headSha);
  const decision = resolveMergeable({
    hasEffectiveDiff: status.hasEffectiveDiff,
    conflict: status.conflict,
    reviewGate,
  });
  return {
    baseSha,
    headSha,
    mergeable: decision.mergeable,
    mergeable_state: decision.mergeable_state,
    hasEffectiveDiff: status.hasEffectiveDiff,
    conflict: status.conflict,
    additions: status.additions,
    deletions: status.deletions,
    changedFiles: status.changedFiles,
    commitsAhead: status.commitsAhead,
  };
}
