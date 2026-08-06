import { localBranchRef, mergeBase } from "./git.ts";
import type { PullRow } from "./store.ts";

// New PRs preserve their exact fork point. Legacy rows have no stored value, so infer the best
// available approximation from the refs as they exist now.
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
