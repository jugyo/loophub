import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GitResult } from "./git.ts";
import {
  cachedGitResult,
  clearGitResultCache,
  immutableGitKey,
  MAX_CACHED_BYTES,
  TTL_MS,
} from "./git-cache.ts";

const REPO = "/tmp/repo";
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

function ok(stdout: string): GitResult {
  return { code: 0, stdout, stderr: "" };
}

function runner(results: GitResult[] | GitResult) {
  const queue = Array.isArray(results) ? [...results] : null;
  const fallback = Array.isArray(results) ? ok("") : results;
  return vi.fn(async () => queue?.shift() ?? fallback);
}

beforeEach(() => {
  clearGitResultCache();
});

afterEach(() => {
  clearGitResultCache();
  vi.useRealTimers();
});

test("invocations resolved to commit SHAs are cacheable", () => {
  const cacheable = [
    ["diff", "--raw", "--numstat", "-z", `${SHA}...${OTHER_SHA}`],
    ["diff", "--ignore-all-space", SHA, OTHER_SHA],
    ["diff", `${SHA}^`, SHA],
    ["diff", "--name-only", `${SHA}...${OTHER_SHA}`, "--", "core/git.ts"],
    ["log", "--max-count=100", "--format=%H%x1f%s", OTHER_SHA, "--not", SHA],
    ["rev-list", "--count", `${SHA}..${OTHER_SHA}`],
    ["merge-base", SHA, OTHER_SHA],
    ["show", `${SHA}:core/git.ts`],
    ["show", SHA],
  ];
  for (const args of cacheable) {
    expect(immutableGitKey(REPO, args), args.join(" ")).not.toBeNull();
  }
});

test("an argument the table does not clear makes the invocation uncacheable", () => {
  // Fail-closed: only the exact spellings the table declares are cached, so a flag nobody has
  // vouched for costs a subprocess instead of risking a stale answer.
  const uncacheable = [
    ["diff", "--stat", SHA, OTHER_SHA], // unknown flag
    ["diff", "-U5", SHA, OTHER_SHA], // unknown short flag
    ["log", "--count", SHA], // cleared for rev-list, not for log
    ["diff", "--numstat=1", SHA, OTHER_SHA], // value on a flag that takes none
    ["log", "--max-count", "100", SHA], // value must be attached, not a separate argument
    ["log", "--max-count=all", SHA], // value the predicate rejects
    ["diff", "--diff-filter=", SHA, OTHER_SHA],
    ["log", "--format=%d", SHA], // ref decorations move when a branch does
    ["log", "--format=%ar", SHA], // rendered against the current time
    ["log", "--format=%aN", SHA], // reads .mailmap out of the working tree
    ["log", "--format=%N", SHA], // notes live in a mutable ref
    // A flag naming an inherited object property must not resolve to anything.
    ["log", "--constructor=x", SHA],
    ["log", "--toString", SHA],
    ["log", "--__proto__=x", SHA],
  ];
  for (const args of uncacheable) {
    expect(immutableGitKey(REPO, args), args.join(" ")).toBeNull();
  }

  // The spellings the call sites actually use stay cached.
  const cacheable = [
    ["diff", "--diff-filter=A", SHA, OTHER_SHA],
    ["log", "--max-count=100", "--format=%H%x1f%an%x1f%cI%x1f%s%x1e", SHA],
    ["rev-list", "--count", `${SHA}..${OTHER_SHA}`],
  ];
  for (const args of cacheable) {
    expect(immutableGitKey(REPO, args), args.join(" ")).not.toBeNull();
  }
});

test("invocations that depend on refs, the working tree or the index are not cacheable", () => {
  const uncacheable = [
    // Reporting where a ref or the working tree currently is, is the point of the call.
    ["rev-parse", "--verify", "--quiet", SHA],
    ["status", "--porcelain"],
    ["worktree", "list", "--porcelain"],
    // Unresolved revisions: a ref can move under the same argv.
    ["diff", "main...feat"],
    ["log", "HEAD"],
    ["show", `HEAD:core/git.ts`],
    ["show", `${SHA.slice(0, 8)}:core/git.ts`],
    ["rev-list", `main..${SHA}`],
    // A single diff endpoint compares against the working tree; none falls back to HEAD.
    ["diff", SHA],
    ["diff", "--numstat"],
    ["log"],
    ["merge-base", SHA],
    ["show"],
    // Flags reaching past the operands.
    ["diff", "--cached", SHA],
    ["log", "--all", SHA],
    ["rev-list", "--stdin", SHA],
    ["log", "--date=relative", SHA],
    ["log", "--format=%cr", SHA],
    // Mutating commands never qualify.
    ["commit", "-qm", "x"],
    ["merge-tree", "--write-tree", SHA, OTHER_SHA],
  ];
  for (const args of uncacheable) {
    expect(immutableGitKey(REPO, args), args.join(" ")).toBeNull();
  }
});

test("per-invocation env overrides are not cacheable", () => {
  expect(immutableGitKey(REPO, ["show", SHA], {})).not.toBeNull();
  expect(
    immutableGitKey(REPO, ["show", SHA], { GIT_CONFIG_GLOBAL: "/dev/null" }),
  ).toBeNull();
});

test("a repeated immutable invocation runs git once", async () => {
  const run = runner(ok("patch"));
  const first = await cachedGitResult(REPO, ["show", SHA], {}, run);
  const second = await cachedGitResult(REPO, ["show", SHA], {}, run);

  expect(run).toHaveBeenCalledTimes(1);
  expect(second).toEqual(first);
  expect(second.stdout).toBe("patch");
});

test("the key covers the repo path and every argument", async () => {
  const run = runner(ok(""));
  await cachedGitResult(REPO, ["show", SHA], {}, run);
  await cachedGitResult("/tmp/other", ["show", SHA], {}, run);
  await cachedGitResult(REPO, ["show", OTHER_SHA], {}, run);
  await cachedGitResult(REPO, ["show", "--stat", SHA], {}, run);

  expect(run).toHaveBeenCalledTimes(4);
});

test("an uncacheable invocation runs git every time", async () => {
  const run = runner(ok(""));
  await cachedGitResult(REPO, ["status", "--porcelain"], {}, run);
  await cachedGitResult(REPO, ["status", "--porcelain"], {}, run);

  expect(run).toHaveBeenCalledTimes(2);
});

test("concurrent callers share one in-flight invocation", async () => {
  const run = runner(ok("patch"));
  const [first, second] = await Promise.all([
    cachedGitResult(REPO, ["show", SHA], {}, run),
    cachedGitResult(REPO, ["show", SHA], {}, run),
  ]);

  expect(run).toHaveBeenCalledTimes(1);
  expect(first).toBe(second);
});

test("an entry is discarded once its TTL passes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-04T00:00:00Z"));
  const run = runner([ok("first"), ok("second")]);

  expect((await cachedGitResult(REPO, ["show", SHA], {}, run)).stdout).toBe(
    "first",
  );
  vi.setSystemTime(new Date(Date.now() + TTL_MS - 1));
  expect((await cachedGitResult(REPO, ["show", SHA], {}, run)).stdout).toBe(
    "first",
  );
  vi.setSystemTime(new Date(Date.now() + 1));
  expect((await cachedGitResult(REPO, ["show", SHA], {}, run)).stdout).toBe(
    "second",
  );
  expect(run).toHaveBeenCalledTimes(2);
});

test("a failed invocation is not cached", async () => {
  const run = runner([
    { code: 128, stdout: "", stderr: "bad object" },
    ok("patch"),
  ]);

  expect((await cachedGitResult(REPO, ["show", SHA], {}, run)).code).toBe(128);
  expect((await cachedGitResult(REPO, ["show", SHA], {}, run)).stdout).toBe(
    "patch",
  );
  expect(run).toHaveBeenCalledTimes(2);
});

test("a rejected invocation is not cached", async () => {
  const run = vi
    .fn<() => Promise<GitResult>>()
    .mockRejectedValueOnce(new Error("spawn failed"))
    .mockResolvedValueOnce(ok("patch"));

  await expect(cachedGitResult(REPO, ["show", SHA], {}, run)).rejects.toThrow(
    "spawn failed",
  );
  expect((await cachedGitResult(REPO, ["show", SHA], {}, run)).stdout).toBe(
    "patch",
  );
});

test("entries are evicted oldest first once the byte budget is exceeded", async () => {
  const small = runner(ok("small"));
  await cachedGitResult(REPO, ["show", SHA], {}, small);
  await cachedGitResult(
    REPO,
    ["show", OTHER_SHA],
    {},
    runner(ok("x".repeat(MAX_CACHED_BYTES + 1))),
  );

  await cachedGitResult(REPO, ["show", SHA], {}, small);
  expect(small).toHaveBeenCalledTimes(2);
});
