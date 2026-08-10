// #2364: the polled callers of the (baseSha, headSha) fan-out share one computation.
//
// The merge preview is the expensive half (a real merge-tree over both trees) and, unlike the diff
// commands. The guarantee has to hold at the pull-status-cache level, and this file asserts it
// against a real repository — including the other half, that a
// moved ref is a different key and never serves the stale answer.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

// Counts the fan-out's git-facing calls. Wrapping the exports pull-status-cache.ts imports (rather
// than the subprocess) keeps every command real while making "did this respawn?" observable.
const calls = vi.hoisted(() => ({ mergePreview: 0, hasEffectiveDiff: 0 }));

vi.mock("./git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git.ts")>();
  return {
    ...actual,
    mergePreview: (...args: Parameters<typeof actual.mergePreview>) => {
      calls.mergePreview++;
      return actual.mergePreview(...args);
    },
    hasEffectiveDiff: (...args: Parameters<typeof actual.hasEffectiveDiff>) => {
      calls.hasEffectiveDiff++;
      return actual.hasEffectiveDiff(...args);
    },
  };
});

const HOME = mkdtempSync(join(tmpdir(), "lh-status-fanout-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let C: typeof import("./pull-status-cache.ts");
let M: typeof import("./pull-mergeable-state.ts");
let G: typeof import("./git.ts");
let S: typeof import("./store.ts");
let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

function commit(file: string, content: string, message: string): string {
  writeFileSync(join(repoPath, file), content);
  git(["add", "-A"]);
  git(["commit", "-qm", message]);
  return git(["rev-parse", "HEAD"]).stdout.trim();
}

beforeAll(async () => {
  C = await import("./pull-status-cache.ts");
  M = await import("./pull-mergeable-state.ts");
  G = await import("./git.ts");
  S = await import("./store.ts");
  svc = await import("./service.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-status-fanout-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  commit("a.txt", "x\n", "init");
  git(["checkout", "-qb", "feature"]);
  commit("b.txt", "feature\n", "add b");
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: "me/fanout" });
  const repo = S.getRepo("me", "fanout")!;
  const issue = S.createIssue(repo.id, "pull", "Feature PR", "", "me");
  S.createPull(issue.id, "feature", "main", null, null);
});

beforeEach(() => {
  C.clearPullShaStatusCache();
  calls.mergePreview = 0;
  calls.hasEffectiveDiff = 0;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

async function shas(): Promise<[string, string]> {
  const [base, head] = await Promise.all([
    G.revParse(repoPath, "main"),
    G.revParse(repoPath, "feature"),
  ]);
  return [base!, head!];
}

// Acceptance: repeated and concurrent asks for one SHA pair run the fan-out once, so an idle tab
// polling the list does not respawn merge-tree per PR per poll.
test("one SHA pair runs the fan-out once, however many callers ask", async () => {
  const [base, head] = await shas();

  const concurrent = await Promise.all([
    C.pullShaStatus(repoPath, base, head),
    C.pullShaStatus(repoPath, base, head),
  ]);
  const later = await C.pullShaStatus(repoPath, base, head);

  expect(concurrent[0]).toEqual(concurrent[1]);
  expect(later).toEqual(concurrent[0]);
  expect(later.hasEffectiveDiff).toBe(true);
  expect(later.changedFiles).toBe(1);
  expect(calls.mergePreview).toBe(1);
  expect(calls.hasEffectiveDiff).toBe(1);
});

// Acceptance: the merge-ready sweep behind the notification badge — which runs over every open PR
// on every read — reuses that same entry instead of calling git with branch names.
test("the sweep's mergeable state reuses the entry the SHA pair already has", async () => {
  const [base, head] = await shas();
  await C.pullShaStatus(repoPath, base, head);
  expect(calls.mergePreview).toBe(1);

  const pull = S.openPulls().find((row) => row.head_ref === "feature")!;
  expect(await M.currentMergeableState(pull)).toBe("blocked");
  expect(await M.currentMergeableState(pull)).toBe("blocked");

  // Still the one fan-out from above: the sweep resolved the refs and hit the same key.
  expect(calls.mergePreview).toBe(1);
  expect(calls.hasEffectiveDiff).toBe(1);
});

// Acceptance: caching on resolved SHAs must not make a moved ref stale. The head here moves to a
// commit that reverts the branch's only change, so a stale answer would still report a diff.
test("a moved head is a new key and reports the new truth", async () => {
  const pull = S.openPulls().find((row) => row.head_ref === "feature")!;
  expect(await M.currentMergeableState(pull)).toBe("blocked");
  const before = calls.mergePreview;

  git(["checkout", "-q", "feature"]);
  git(["rm", "-q", "b.txt"]);
  git(["commit", "-qm", "revert b"]);
  git(["checkout", "-q", "main"]);

  // No effective diff left, so the PR has nothing to merge.
  expect(await M.currentMergeableState(pull)).toBe("no_commits");
  expect(calls.mergePreview).toBeGreaterThan(before);
});
