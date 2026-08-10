// #1668: The SHA-derived slice of an open PR's git fan-out, cached on the SHA pair it is a
// function of.
//
// For an open PR this fan-out spawns git several times: the merge preview (merge-tree
// --write-tree), commits-ahead, effective-diff, and diff stat. All four are deterministic in the
// resolved (baseSha, headSha) pair — the same pair always yields the same result — so a client
// that refetches a list while no ref has moved reuses the previous result and spawns zero git
// subprocesses for it. This is the dominant cost when a workflow run's events drive a ~1.5s list
// refetch across every open PR.
//
// #2364: every caller resolves its refs first and asks for the SHA pair, so they all share one
// entry: the serializers rendering a list, the merge-ready sweep behind the notification badge,
// and the Workflow run state on issue/PR detail. Calling with branch names instead would key
// nothing and re-spawn merge-tree per poll.
//
// Deliberately NOT cached here: `working` (worktree dirty) and review state. Neither is a
// function of the SHA pair — the worktree can go dirty/clean and a review can be submitted
// without either ref moving — so callers recompute them every call. revParse of the refs also
// stays uncached: it is exactly the probe that detects a moved ref, i.e. a cache miss.

import {
  commitsAhead,
  diffStat,
  hasEffectiveDiff,
  mergePreview,
} from "./git.ts";

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

// The one git fan-out behind an entry. A diff-stat failure must not break the caller — fall back
// to zeros — while the other three propagate, matching what pullStatusFields did inline before
// this moved here.
function computePullShaStatus(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<PullShaStatus> {
  return Promise.all([
    mergePreview(repoPath, baseSha, headSha),
    commitsAhead(repoPath, baseSha, headSha),
    hasEffectiveDiff(repoPath, baseSha, headSha),
    diffStat(repoPath, baseSha, headSha).catch(() => ({
      additions: 0,
      deletions: 0,
      changedFiles: 0,
    })),
  ]).then(([preview, ahead, effectiveDiff, stat]) => ({
    conflict: preview.conflict,
    commitsAhead: ahead,
    hasEffectiveDiff: effectiveDiff,
    additions: stat.additions,
    deletions: stat.deletions,
    changedFiles: stat.changedFiles,
  }));
}

/**
 * The SHA-derived status of `baseSha...headSha` in `repoPath`, computed once per pair.
 *
 * This is the entry point every caller uses; `cachedPullShaStatus` stays separate only so the
 * cache's semantics can be unit-tested without a git repo. Pass resolved SHAs: a branch name
 * would key an entry that never invalidates when the ref moves.
 */
export function pullShaStatus(
  repoPath: string,
  baseSha: string,
  headSha: string,
): Promise<PullShaStatus> {
  return cachedPullShaStatus(repoPath, baseSha, headSha, () =>
    computePullShaStatus(repoPath, baseSha, headSha),
  );
}

// Test-only: drop all cached entries so a test starts from a cold cache.
export function clearPullShaStatusCache(): void {
  cache.clear();
}
