import { afterEach, expect, test } from "vitest";
import {
  cachedPullShaStatus,
  clearPullShaStatusCache,
  type PullShaStatus,
} from "./pull-status-cache.ts";

const status = (commitsAhead: number): PullShaStatus => ({
  conflict: false,
  commitsAhead,
  hasEffectiveDiff: true,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
});

afterEach(() => clearPullShaStatusCache());

// Acceptance: re-resolving the same (baseSha, headSha) does not recompute — the
// git fan-out runs once, so a refetch with no moved ref spawns zero git.
test("same SHA pair reuses the cached result without recomputing", async () => {
  let computed = 0;
  const run = () =>
    cachedPullShaStatus("/repo", "base1", "head1", async () => {
      computed++;
      return status(2);
    });

  expect(await run()).toEqual(status(2));
  expect(await run()).toEqual(status(2));
  expect(await run()).toEqual(status(2));
  expect(computed).toBe(1);
});

// Acceptance: a moved ref (new headSha/baseSha) is a distinct key, so it is
// recomputed rather than served the stale value.
test("a changed SHA recomputes", async () => {
  let computed = 0;
  const compute = (n: number) => async () => {
    computed++;
    return status(n);
  };

  expect(
    await cachedPullShaStatus("/repo", "base1", "head1", compute(1)),
  ).toEqual(status(1));
  // head moved
  expect(
    await cachedPullShaStatus("/repo", "base1", "head2", compute(2)),
  ).toEqual(status(2));
  // base moved
  expect(
    await cachedPullShaStatus("/repo", "base2", "head2", compute(3)),
  ).toEqual(status(3));
  expect(computed).toBe(3);
});

// The repo path is part of the key: two repos that happen to share a SHA pair
// do not collide.
test("different repo paths do not collide", async () => {
  let computed = 0;
  const compute = (n: number) => async () => {
    computed++;
    return status(n);
  };

  await cachedPullShaStatus("/repo-a", "b", "h", compute(1));
  await cachedPullShaStatus("/repo-b", "b", "h", compute(2));
  expect(computed).toBe(2);
});

// Concurrent rows for the same pair (same PR in the issue list and the PR list
// within one tick) share a single in-flight compute.
test("concurrent calls for the same pair compute once", async () => {
  let computed = 0;
  const run = () =>
    cachedPullShaStatus("/repo", "base1", "head1", async () => {
      computed++;
      await new Promise((r) => setTimeout(r, 5));
      return status(7);
    });

  const [a, b] = await Promise.all([run(), run()]);
  expect(a).toEqual(status(7));
  expect(b).toEqual(status(7));
  expect(computed).toBe(1);
});

// A failed compute is not cached: the next call retries instead of replaying
// the rejection forever.
test("a rejected compute is evicted and retried", async () => {
  let calls = 0;
  const run = () =>
    cachedPullShaStatus("/repo", "base1", "head1", async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return status(9);
    });

  await expect(run()).rejects.toThrow("boom");
  expect(await run()).toEqual(status(9));
  expect(calls).toBe(2);
});
