import { hasEffectiveDiff, mergePreview, revParse } from "./git.ts";
import type { MergeableState } from "./mergeable.ts";
import { resolveMergeable } from "./mergeable.ts";
import * as S from "./store.ts";

// Compute one open PR's current mergeable_state from live git + review signals, reusing the same
// pure classifier serialize.ts's mergePreview path feeds (#427). Shared by the merge-ready
// notification sweep and the conflict sweep so both read a single definition of "what state is
// this PR in now" instead of each re-deriving it (#1232).
export async function currentMergeableState(
  pull: S.OpenPullSweepRow,
): Promise<MergeableState> {
  const [headSha, baseSha] = await Promise.all([
    revParse(pull.local_path, pull.head_ref),
    revParse(pull.local_path, pull.base_ref),
  ]);
  if (!headSha || !baseSha) return "unknown";

  const [preview, effectiveDiff] = await Promise.all([
    mergePreview(pull.local_path, pull.base_ref, pull.head_ref),
    hasEffectiveDiff(pull.local_path, pull.base_ref, pull.head_ref),
  ]);
  const reviewGate = S.computeReviewGate(pull.issue_id, headSha);
  return resolveMergeable({
    hasEffectiveDiff: effectiveDiff,
    conflict: preview.conflict,
    reviewed: reviewGate.reviewed,
    reviewPassed: reviewGate.passed,
  }).mergeable_state;
}
