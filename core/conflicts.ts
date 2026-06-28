// Cross-PR conflict relations: for a given open PR, which other open PRs would
// merge-conflict with it (PR head vs PR head). The git fan-out lives here rather
// than in serialize.ts so the orchestration is reusable and unit-testable.
//
// Semantics: head-vs-head. `mergeConflict(headA, headB)` finds the merge-base of
// the two heads automatically and tries the merge in memory — answering "if both
// PRs were merged independently, do they touch the same lines?".
//
// Cost: computed on demand only for a PR *detail* view (O(other open PRs)); the PR
// *list* skips it to avoid an O(n^2) fan-out. A conflict result depends only on the
// two head shas (the merge-base is derived from them) and is symmetric, so it is
// memoized on the sorted sha pair for the process lifetime — repeated detail views
// and SSE-driven refetches reuse the cached result instead of re-running git.

import { mergeConflict, revParse } from "./git.ts";
import * as S from "./store.ts";

export interface PullConflict {
  number: number;
  title: string;
  files: string[];
}

// Bounded so a long-lived lh-web process can't grow the cache without limit: every
// new commit on any open PR mints a fresh head sha (a new key), so the key space
// churns indefinitely. Results are content-addressed by immutable shas, so evicting
// the oldest entry only costs a recompute. Map preserves insertion order — delete the
// first key when over capacity (simple FIFO; good enough for a recompute-cheap cache).
const MAX_CACHE_ENTRIES = 2000;
const cache = new Map<string, { conflict: boolean; files: string[] }>();

function cacheSet(key: string, value: { conflict: boolean; files: string[] }) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function pairKey(repoPath: string, a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${repoPath}\0${x}\0${y}`;
}

// Resolve an open PR's head ref to a sha, optionally memoized through a
// caller-provided cache. The merge-result cache below is content-addressed by
// immutable shas, but resolving a *ref* → sha is not memoized there (a ref's sha
// changes as commits land). When the issue list enriches many PRs in one build,
// every PR's conflictsForPull loops over the *same* set of other open PRs, so the
// same head refs would be rev-parsed once per self-PR — O(K×M) git spawns. A
// per-build cache (created once per list response, lifetime bounded to that build)
// collapses that to one rev-parse per open PR. Omit the cache (PR detail) to keep
// the original always-fresh resolution. The Promise is cached so concurrent
// lookups for the same ref share a single spawn.
function resolveHeadSha(
  repoPath: string,
  headRef: string,
  cache?: Map<string, Promise<string | null>>,
): Promise<string | null> {
  if (!cache) return revParse(repoPath, headRef);
  const key = `${repoPath}\0${headRef}`;
  let p = cache.get(key);
  if (!p) {
    p = revParse(repoPath, headRef);
    cache.set(key, p);
  }
  return p;
}

// Conflicts between `self` (an open PR) and every *other* open PR in the same repo.
// `selfHeadSha` is the already-resolved head sha of `self` (serialize.ts computes it
// once); pass null when it can't be resolved, in which case no conflicts are reported.
// `headShaCache` (optional) memoizes other-PR ref→sha resolution across calls within a
// single issue-list build; see resolveHeadSha.
export async function conflictsForPull(
  repo: S.Repo,
  selfNumber: number,
  selfHeadSha: string | null,
  headShaCache?: Map<string, Promise<string | null>>,
): Promise<PullConflict[]> {
  if (!selfHeadSha) return [];
  const out: PullConflict[] = [];
  for (const other of S.listOpenPullsForRepo(repo.id)) {
    if (other.number === selfNumber) continue;
    const otherSha = await resolveHeadSha(
      repo.local_path,
      other.head_ref,
      headShaCache,
    );
    if (!otherSha) continue;
    const key = pairKey(repo.local_path, selfHeadSha, otherSha);
    let res = cache.get(key);
    if (!res) {
      res = await mergeConflict(repo.local_path, selfHeadSha, otherSha);
      cacheSet(key, res);
    }
    if (res.conflict)
      out.push({
        number: other.number,
        title: other.title,
        files: res.files,
      });
  }
  return out;
}
