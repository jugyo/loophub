import { isAncestor, localBranchRef, mergeBase, revParse } from "./git.ts";
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

// Left side of the live three-dot PR diff: merge-base of the preferred base tip and head.
//
// Distinct from resolvePullBaseSha (fork point at PR creation). Comparing the fork point to
// head as a two-dot tree diff includes every base-side change that landed after the fork and
// was later merged into head — those files are not this PR's changes.
//
// Candidates for the base tip are the local base_ref and, when present,
// refs/remotes/origin/<base_ref>. Agents often merge origin/<base> while the local base branch
// still lags; three-dot against the stale local tip then lists every file brought in by that
// merge. The recorded fork point joins them when head still contains it (#2444): rebasing the
// base branch rewrites the commits head forked from, so every live merge-base drops back to a
// commit from before the rewrite and the diff picks up base-side files again — the fork point
// survives the rewrite inside head and is still the newest base commit head contains.
//
// Among the candidates we keep the one that is a descendant of the others — i.e. the newest base
// commit already integrated into head (or the sole common ancestor when the remote tip has not
// been merged yet).
export async function resolvePullDiffBaseSha(
  repoPath: string,
  pull: Pick<PullRow, "base_sha" | "base_ref" | "head_ref">,
): Promise<string | null> {
  const head = localBranchRef(pull.head_ref);
  const tips = [
    localBranchRef(pull.base_ref),
    `refs/remotes/origin/${pull.base_ref}`,
  ];
  const candidates: string[] = [];
  for (const tip of tips) {
    if (!(await revParse(repoPath, tip))) continue;
    const mb = await mergeBase(repoPath, tip, head);
    if (mb) candidates.push(mb);
  }
  // Only while head still contains it: a rebased head, or one reset before the fork point, has
  // left the recorded base behind, and diffing from it would report base-side changes again.
  if (pull.base_sha && (await isAncestor(repoPath, pull.base_sha, head))) {
    candidates.push(pull.base_sha);
  }
  let best: string | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      (best !== candidate && (await isAncestor(repoPath, best, candidate)))
    ) {
      best = candidate;
    }
  }
  return best;
}
