// #2364: the polled callers of the (baseSha, headSha) fan-out share one computation.
//
// The merge preview is the expensive half (a real merge-tree over both trees) and, unlike the diff
// commands. The guarantee has to hold at the pull-status-cache level, and this file asserts it
// against a real repository — including the other half, that a
// moved ref is a different key and never serves the stale answer.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { traceGitCommands } from "./git-trace-test-helper.ts";

// The fan-out's two expensive halves, named by the git command each one spawns. Counting the real
// subprocesses through GIT_TRACE2 (rather than wrapping git.ts) keeps every command real while
// making "did this respawn?" observable.
const MERGE_PREVIEW = "merge-tree";
const HAS_EFFECTIVE_DIFF = "diff --name-only";

function spawned(commands: string[], prefix: string): number {
  return commands.filter((command) => command.startsWith(prefix)).length;
}

const HOME = mkdtempSync(join(tmpdir(), "lh-status-fanout-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let C: typeof import("./pull-status-cache.ts");
let M: typeof import("./pull-mergeable-state.ts");
let G: typeof import("./git.ts");
let S: typeof import("./store.ts");
let W: typeof import("./watcher.ts");
let Z: typeof import("./serialize-status.ts");
let svc: typeof import("./service.ts");
let repoPath: string;
let linkedIssueId: number;

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
  W = await import("./watcher.ts");
  Z = await import("./serialize-status.ts");
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
  const linkedIssue = S.createIssue(
    repo.id,
    "issue",
    "Feature issue",
    "",
    "me",
  );
  linkedIssueId = linkedIssue.id;
  const issue = S.createIssue(repo.id, "pull", "Feature PR", "", "me");
  S.createPull(issue.id, "feature", "main", null, linkedIssue.id);
});

beforeEach(() => {
  C.clearPullShaStatusCache();
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

  const { result, commands } = await traceGitCommands(async () => {
    const concurrent = await Promise.all([
      C.pullShaStatus(repoPath, base, head),
      C.pullShaStatus(repoPath, base, head),
    ]);
    return { concurrent, later: await C.pullShaStatus(repoPath, base, head) };
  });
  const { concurrent, later } = result;

  expect(concurrent[0]).toEqual(concurrent[1]);
  expect(later).toEqual(concurrent[0]);
  expect(later.hasEffectiveDiff).toBe(true);
  expect(later.changedFiles).toBe(1);
  expect(spawned(commands, MERGE_PREVIEW)).toBe(1);
  expect(spawned(commands, HAS_EFFECTIVE_DIFF)).toBe(1);
});

// Acceptance: the merge-ready sweep behind the notification badge — which runs over every open PR
// on every read — reuses that same entry instead of calling git with branch names.
test("the sweep's mergeable state reuses the entry the SHA pair already has", async () => {
  const [base, head] = await shas();
  const first = await traceGitCommands(() =>
    C.pullShaStatus(repoPath, base, head),
  );
  expect(spawned(first.commands, MERGE_PREVIEW)).toBe(1);

  const pull = S.openPulls().find((row) => row.head_ref === "feature")!;
  const reuse = await traceGitCommands(async () => {
    expect(await M.currentMergeableState(pull)).toBe("blocked");
    expect(await M.currentMergeableState(pull)).toBe("blocked");
  });

  // Still the one fan-out from above: the sweep resolved the refs and hit the same key.
  expect(spawned(reuse.commands, MERGE_PREVIEW)).toBe(0);
  expect(spawned(reuse.commands, HAS_EFFECTIVE_DIFF)).toBe(0);
});

test("the pull sweep persists the SHA projection and the issue list reads it", async () => {
  await W.sweepPullUpdates();
  const pull = S.openPulls().find((row) => row.head_ref === "feature")!;
  const [base, head] = await shas();
  expect(S.getPullStatusProjection(base, head)).toMatchObject({
    base_sha: base,
    head_sha: head,
    mergeable_state: "blocked",
    additions: 1,
    deletions: 0,
    changed_files: 1,
    commits_ahead: 1,
  });

  S.upsertPullStatusProjection({
    baseSha: base,
    headSha: head,
    mergeable: true,
    mergeableState: "clean",
    hasEffectiveDiff: true,
    conflict: false,
    additions: 9,
    deletions: 8,
    changedFiles: 7,
    commitsAhead: 6,
  });
  S.upsertCurrentPullStatusProjection({
    issueId: pull.issue_id,
    baseSha: base,
    headSha: head,
    mergeable: true,
    mergeableState: "clean",
    hasEffectiveDiff: true,
    conflict: false,
    additions: 9,
    deletions: 8,
    changedFiles: 7,
    commitsAhead: 6,
    baseCommitsBehind: 5,
  });
  const row = S.getIssueById(linkedIssueId)!;
  const repo = S.getRepoById(pull.repo_id)!;
  const { result: out, commands } = await traceGitCommands(() =>
    Z.issueListItemJSON(row, repo),
  );
  expect(out.linked_pull_request).toMatchObject({
    mergeable_state: "blocked",
    additions: 9,
    deletions: 8,
    changed_files: 7,
    commits_ahead: 6,
    base_commits_behind: 5,
  });
  expect(spawned(commands, MERGE_PREVIEW)).toBe(0);
  expect(spawned(commands, HAS_EFFECTIVE_DIFF)).toBe(0);
});

test("an unchanged pull sweep reuses the current projection", async () => {
  const benchmarkIssues: number[] = [];
  const tracePath = join(HOME, "git-trace.json");
  const mainSha = (await G.revParse(repoPath, "main"))!;
  for (let i = 1; i < 10; i++) {
    const branch = `benchmark-feature-${i}`;
    git(["checkout", "-qb", branch, "main"]);
    commit(`benchmark-${i}.txt`, `${i}\n`, `benchmark ${i}`);
    git(["checkout", "-q", "main"]);
    const issue = S.createIssue(
      S.getRepo("me", "fanout")!.id,
      "pull",
      `Benchmark PR ${i}`,
      "",
      "me",
    );
    S.createPull(issue.id, branch, "main", null, null, null, mainSha);
    benchmarkIssues.push(issue.id);
  }

  try {
    expect(S.openPulls()).toHaveLength(10);
    for (const pull of S.openPulls())
      S.deleteCurrentPullStatusProjection(pull.issue_id);
    C.clearPullShaStatusCache();
    process.env.GIT_TRACE2_EVENT = tracePath;

    writeFileSync(tracePath, "");
    const baselineStartedAt = performance.now();
    await W.sweepPullUpdates();
    const baselineMs = performance.now() - baselineStartedAt;
    const countGitCommands = () =>
      readFileSync(tracePath, "utf8")
        .split("\n")
        .filter((line) => {
          try {
            return JSON.parse(line).event === "version";
          } catch {
            return false;
          }
        }).length;
    const baselineCommands = countGitCommands();

    writeFileSync(tracePath, "");
    const unchangedStartedAt = performance.now();
    await W.sweepPullUpdates();
    const unchangedMs = performance.now() - unchangedStartedAt;
    const unchangedCommands = countGitCommands();

    console.info(
      `10 open PR unchanged sweep: baseline=${baselineCommands} git commands/${baselineMs.toFixed(1)}ms; ` +
        `unchanged=${unchangedCommands} git commands/${unchangedMs.toFixed(1)}ms`,
    );
    expect(baselineCommands).toBeGreaterThan(unchangedCommands);
    expect(unchangedMs).toBeGreaterThanOrEqual(0);
    expect(baselineMs).toBeGreaterThanOrEqual(0);
  } finally {
    delete process.env.GIT_TRACE2_EVENT;
    for (const issueId of benchmarkIssues)
      S.updateIssue(issueId, { state: "closed" });
  }
}, 15_000);

test("a projection reapplies the current review gate", async () => {
  const [base, head] = await shas();
  S.upsertPullStatusProjection({
    baseSha: base,
    headSha: head,
    mergeable: true,
    mergeableState: "clean",
    hasEffectiveDiff: true,
    conflict: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commitsAhead: 1,
  });
  const pull = S.openPulls().find((row) => row.head_ref === "feature")!;
  S.upsertCurrentPullStatusProjection({
    issueId: pull.issue_id,
    baseSha: base,
    headSha: head,
    mergeable: true,
    mergeableState: "clean",
    hasEffectiveDiff: true,
    conflict: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commitsAhead: 1,
    baseCommitsBehind: 0,
  });
  const repo = S.getRepoById(pull.repo_id)!;
  const row = S.getIssueById(linkedIssueId)!;
  expect(
    (await Z.issueListItemJSON(row, repo)).linked_pull_request,
  ).toMatchObject({ mergeable_state: "blocked" });
});

// Acceptance: caching on resolved SHAs must not make a moved ref stale. The head here moves to a
// commit that reverts the branch's only change, so a stale answer would still report a diff.
test("a moved head is a new key and reports the new truth", async () => {
  const pull = S.openPulls().find((row) => row.head_ref === "feature")!;
  expect(await M.currentMergeableState(pull)).toBe("blocked");

  git(["checkout", "-q", "feature"]);
  git(["rm", "-q", "b.txt"]);
  git(["commit", "-qm", "revert b"]);
  git(["checkout", "-q", "main"]);

  // No effective diff left, so the PR has nothing to merge.
  const moved = await traceGitCommands(() => M.currentMergeableState(pull));
  expect(moved.result).toBe("no_commits");
  expect(spawned(moved.commands, MERGE_PREVIEW)).toBeGreaterThan(0);

  await W.sweepPullUpdates();
  const row = S.getIssueById(linkedIssueId)!;
  const repo = S.getRepoById(pull.repo_id)!;
  expect(
    (await Z.issueListItemJSON(row, repo)).linked_pull_request,
  ).toMatchObject({
    mergeable_state: "no_commits",
    additions: 0,
    changed_files: 0,
    commits_ahead: 2,
  });
});

test("a closed linked PR without a current projection keeps its historical status", async () => {
  const repo = S.getRepo("me", "fanout")!;
  git(["checkout", "-qb", "closed-feature", "main"]);
  commit("closed.txt", "closed\n", "closed PR");
  git(["checkout", "-q", "main"]);
  const closed = S.createIssue(repo.id, "pull", "Closed PR", "", "me");
  S.createPull(closed.id, "closed-feature", "main", null, linkedIssueId);
  S.updateIssue(closed.id, { state: "closed" });

  const row = S.getIssueById(linkedIssueId)!;
  const out = await Z.issueListItemJSON(row, repo);
  const linked = out.linked_pull_requests?.find(
    (pull) => pull.number === closed.number,
  );
  expect(linked).toMatchObject({
    mergeable_state: "blocked",
    additions: 1,
    changed_files: 1,
    commits_ahead: 1,
  });
});

test("a merged linked PR ignores its retained active projection", async () => {
  const repo = S.getRepo("me", "fanout")!;
  git(["checkout", "-qb", "merged-feature", "main"]);
  commit("merged.txt", "merged\n", "merged PR");
  git(["checkout", "-q", "main"]);
  const merged = S.createIssue(repo.id, "pull", "Merged PR", "", "me");
  S.createPull(merged.id, "merged-feature", "main", null, linkedIssueId);
  await W.sweepPullUpdates();
  S.setMerged(merged.id, "merge-sha", "merge");

  const row = S.getIssueById(linkedIssueId)!;
  const out = await Z.issueListItemJSON(row, repo);
  const linked = out.linked_pull_requests?.find(
    (pull) => pull.number === merged.number,
  );
  expect(linked).toMatchObject({
    merged: true,
    mergeable_state: "unknown",
    additions: 0,
    deletions: 0,
    changed_files: 0,
  });
});

test("a missing ref removes the current projection and shows unknown", async () => {
  const repo = S.getRepo("me", "fanout")!;
  git(["checkout", "-qb", "missing-feature", "main"]);
  commit("missing.txt", "missing\n", "missing PR");
  git(["checkout", "-q", "main"]);
  const missing = S.createIssue(repo.id, "pull", "Missing PR", "", "me");
  S.createPull(missing.id, "missing-feature", "main", null, linkedIssueId);
  await W.sweepPullUpdates();
  expect(S.getCurrentPullStatusProjection(missing.id)).not.toBeNull();

  git(["branch", "-D", "missing-feature"]);
  await W.sweepPullUpdates();
  expect(S.getCurrentPullStatusProjection(missing.id)).toBeNull();

  const row = S.getIssueById(linkedIssueId)!;
  const out = await Z.issueListItemJSON(row, repo);
  const linked = out.linked_pull_requests?.find(
    (pull) => pull.number === missing.number,
  );
  expect(linked).toMatchObject({
    mergeable_state: "unknown",
    additions: 0,
    deletions: 0,
    changed_files: 0,
    commits_ahead: 0,
  });
});
