// #1668: Cache the SHA-derived slice of pullStatusFields' git fan-out.
//
// For an open PR, `pullStatusFields` (core/serialize.ts) spawns git several
// times per row: the merge preview (merge-tree --write-tree), commits-ahead,
// effective-diff, and diff stat. All four are deterministic in the resolved
// (baseSha, headSha) pair — the same pair always yields the same result — so a
// client that refetches a list while no ref has moved reuses the previous
// result and spawns zero git subprocesses for it. This is the dominant cost
// when a workflow run's events drive a ~1.5s list refetch across every open PR.
//
// Deliberately NOT cached here: `working` (worktree dirty) and review state.
// Neither is a function of the SHA pair — the worktree can go dirty/clean and
// a review can be submitted without either ref moving — so pullStatusFields
// recomputes them every call. revParse of the refs also stays uncached: it is
// exactly the probe that detects a moved ref, i.e. a cache miss.

export interface PullShaStatus {
  conflict: boolean;
  commitsAhead: number;
  hasEffectiveDiff: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
}

// Bounded so a long-lived process does not accumulate one entry per historical
// SHA pair. LRU by access order: the hot working set (open PRs refetched in a
// loop) stays resident while stale pairs fall off.
const MAX_ENTRIES = 512;

const cache = new Map<string, Promise<PullShaStatus>>();

function cacheKey(repoPath: string, baseSha: string, headSha: string): string {
  return `${repoPath}\0${baseSha}\0${headSha}`;
}

// Return the SHA-derived status for (baseSha, headSha), running `compute` only
// on a miss. The in-flight promise is cached so concurrent rows for the same
// pair (e.g. the same PR in both the issue list and the PR list) share one git
// fan-out; a rejected compute is evicted so the next call retries.
export function cachedPullShaStatus(
  repoPath: string,
  baseSha: string,
  headSha: string,
  compute: () => Promise<PullShaStatus>,
): Promise<PullShaStatus> {
  const key = cacheKey(repoPath, baseSha, headSha);
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency so the working set survives eviction.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const pending = compute();
  cache.set(key, pending);
  pending.catch(() => {
    // Never cache a failure — let the next call retry.
    if (cache.get(key) === pending) cache.delete(key);
  });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return pending;
}

// Test-only: drop all cached entries so a test starts from a cold cache.
export function clearPullShaStatusCache(): void {
  cache.clear();
}
