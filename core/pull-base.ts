import {
  isAncestor,
  isAncestorIgnoringShallow,
  isShallowRepository,
  localBranchRef,
  mergeBase,
  mergeBaseIgnoringShallow,
  revParse,
} from "./git.ts";
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
// been merged yet). When no candidate dominates, the fold keeps the tip-based one: it is the base
// branch's own view of what head has integrated, which is what a three-dot diff against the
// current base tip means. Preferring the fork point there instead would drag the diff back to
// before the rewrite and list the base-side files again (#98).
export async function resolvePullDiffBaseSha(
  repoPath: string,
  pull: Pick<PullRow, "base_sha" | "base_ref" | "head_ref">,
): Promise<string | null> {
  return (await resolvePullDiffBaseShas(repoPath, pull))[0] ?? null;
}

// The base views we can name from the refs and the recorded fork point, preferred diff base first.
//
// A single base is enough for the two-endpoint Files-changed diff, but not for the commit list:
// `git log <head> --not <base>` re-lists everything the chosen base cannot reach. When the base
// branch is rewritten and head then merges the rewritten line, head holds both the fork point and
// its rewritten twin and neither is an ancestor of the other (#98) — whichever one wins the fold,
// the other line's commits show up as this PR's own. `--not` is a set operation, so passing all of
// them fixes that without disturbing which one won the fold.
//
// This names the base views that still have a ref or a stored SHA, not every base view head
// absorbed: a PR that merged the base before an earlier rewrite holds a view nothing points at
// any more. The commit list closes that gap by walking first parents (see commitLog), so this
// list does not have to be exhaustive.
export async function resolvePullDiffBaseShas(
  repoPath: string,
  pull: Pick<PullRow, "base_sha" | "base_ref" | "head_ref">,
): Promise<string[]> {
  const head = localBranchRef(pull.head_ref);
  const tips = [
    localBranchRef(pull.base_ref),
    `refs/remotes/origin/${pull.base_ref}`,
  ];
  const candidates: string[] = [];
  for (const tip of tips) {
    if (!(await revParse(repoPath, tip))) continue;
    const mb = await mergeBase(repoPath, tip, head);
    if (mb && !candidates.includes(mb)) candidates.push(mb);
  }
  // Only while head still contains it: a rebased head, or one reset before the fork point, has
  // left the recorded base behind, and diffing from it would report base-side changes again.
  if (
    pull.base_sha &&
    !candidates.includes(pull.base_sha) &&
    (await isAncestor(repoPath, pull.base_sha, head))
  ) {
    candidates.push(pull.base_sha);
  }
  // A shallow fetch can leave the base and head tips present while hiding the parent chain that
  // connects them. Retry only when normal ancestry found nothing, and only without the shallow
  // boundary: this never fetches or mutates the repo, and succeeds only if the parent objects are
  // already available locally.
  if (candidates.length === 0 && (await isShallowRepository(repoPath))) {
    for (const tip of tips) {
      if (!(await revParse(repoPath, tip))) continue;
      const mb = await mergeBaseIgnoringShallow(repoPath, tip, head);
      if (mb && !candidates.includes(mb)) candidates.push(mb);
    }
    if (
      pull.base_sha &&
      !candidates.includes(pull.base_sha) &&
      (await isAncestorIgnoringShallow(repoPath, pull.base_sha, head))
    ) {
      candidates.push(pull.base_sha);
    }
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
  if (best === null) return [];
  return [best, ...candidates.filter((sha) => sha !== best)];
}
