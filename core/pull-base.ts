import { localBranchRef, mergeBase } from "./git.ts";
import type { PullRow } from "./store.ts";

// New PRs preserve their exact fork point. Legacy rows have no stored value, so infer the best
// available approximation from the refs as they exist now.
//
// This is the parallel-attempt / "where did this PR start" marker (pulls.base_sha on the wire).
// It is NOT the left side of the live Files-changed diff — see resolvePullDiffBaseSha.
export function resolvePullBaseSha(
  repoPath: string,
  pull: Pick<PullRow, "base_sha" | "base_ref" | "head_ref">,
): Promise<string | null> {
  if (pull.base_sha) return Promise.resolve(pull.base_sha);
  return mergeBase(
    repoPath,
    localBranchRef(pull.base_ref),
    localBranchRef(pull.head_ref),
  );
}

// Left side of the live three-dot PR diff: merge-base(base_ref, head_ref).
//
// Distinct from resolvePullBaseSha (fork point at PR creation). Comparing the fork point to
// head as a two-dot tree diff includes every base-side change that landed after the fork and
// was later merged into head — those files are not this PR's changes. Using the live
// merge-base matches `git diff base...head` / list-side diffStat / hasEffectiveDiff.
export function resolvePullDiffBaseSha(
  repoPath: string,
  pull: Pick<PullRow, "base_ref" | "head_ref">,
): Promise<string | null> {
  return mergeBase(
    repoPath,
    localBranchRef(pull.base_ref),
    localBranchRef(pull.head_ref),
  );
}
