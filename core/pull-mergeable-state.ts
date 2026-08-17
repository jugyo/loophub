import { commitsAhead, localBranchRef, revParse } from "./git.ts";
import type { MergeableState } from "./mergeable.ts";
import { resolveMergeable } from "./mergeable.ts";
import { resolvePullBaseSha } from "./pull-base.ts";
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
  previousProjection?: S.CurrentPullStatusProjection | null,
): Promise<MergeableState> {
  return (
    (await currentPullStatus(pull, previousProjection))?.mergeable_state ??
    "unknown"
  );
}

export async function currentPullStatus(
  pull: S.OpenPullSweepRow,
  previousProjection?: S.CurrentPullStatusProjection | null,
): Promise<{
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
  baseCommitsBehind: number;
} | null> {
  const [headSha, baseSha] = await Promise.all([
    revParse(pull.local_path, localBranchRef(pull.head_ref)),
    revParse(pull.local_path, localBranchRef(pull.base_ref)),
  ]);
  if (!headSha || !baseSha) return null;

  const reviewGate = S.computeReviewGate(pull.issue_id, headSha);
  const reusableProjection =
    previousProjection?.base_sha === baseSha &&
    previousProjection.head_sha === headSha
      ? previousProjection
      : null;
  if (reusableProjection) {
    const decision = resolveMergeable({
      hasEffectiveDiff: reusableProjection.has_effective_diff === 1,
      conflict: reusableProjection.conflict === 1,
      reviewGate,
    });
    return {
      baseSha,
      headSha,
      mergeable: decision.mergeable,
      mergeable_state: decision.mergeable_state,
      hasEffectiveDiff: reusableProjection.has_effective_diff === 1,
      conflict: reusableProjection.conflict === 1,
      additions: reusableProjection.additions,
      deletions: reusableProjection.deletions,
      changedFiles: reusableProjection.changed_files,
      commitsAhead: reusableProjection.commits_ahead,
      baseCommitsBehind: reusableProjection.base_commits_behind,
    };
  }
  const status = await pullShaStatus(pull.local_path, baseSha, headSha);
  const decision = resolveMergeable({
    hasEffectiveDiff: status.hasEffectiveDiff,
    conflict: status.conflict,
    reviewGate,
  });
  const forkBaseSha = await resolvePullBaseSha(
    pull.local_path,
    S.getPull(pull.issue_id)!,
  );
  const baseCommitsBehind = forkBaseSha
    ? await commitsAhead(pull.local_path, forkBaseSha, baseSha)
    : 0;
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
    baseCommitsBehind,
  };
}
