import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";
import type { GhPrStatus } from "./github.ts";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-ghsync-job-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let job: typeof import("./github-pull-sync-job.ts");
let mergeSync: typeof import("./github-merge-sync.ts");
let repoPath: string;
let ghNumber = 100;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function openGithubLinkedPull() {
  const githubNumber = ghNumber++;
  const branch = `feature-${githubNumber}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "y\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature work"]);
  git(["checkout", "-q", "main"]);
  const pr = await svc.pulls.create("me/proj", { head: branch, base: "main" });
  const url = `https://github.com/me/proj/pull/${githubNumber}`;
  svc.pulls.recordGithubPull("me/proj", pr.number, {
    github_number: githubNumber,
    url,
  });
  const repo = S.getRepo("me", "proj")!;
  return {
    number: pr.number as number,
    issueId: S.getIssue(repo.id, pr.number)!.id,
    url,
  };
}

const STATUS: GhPrStatus = {
  state: "open",
  merged: false,
  mergeable: "mergeable",
  reviewDecision: null,
  checks: "success",
  comments: 0,
  reviews: 0,
  updatedAt: "2026-07-01T00:00:00Z",
  commitShas: [],
  isDraft: false,
  reviewers: [],
  checkRuns: [],
  headSha: null,
};

const okDeps = {
  fetchMergeStatus: async () => ({
    merged: false,
    mergedAt: null,
    mergedByLogin: null,
  }),
  fetchStatus: async () => STATUS,
  fetchFeedback: async () => [],
  fetchOrigin: async () => ({ code: 0, stdout: "", stderr: "" }),
};

function claim() {
  const claimed = svc.jobs.claimNext();
  expect(claimed?.type).toBe(job.SYNC_GITHUB_PULL_JOB);
  return claimed!;
}

function syncFinishedEvents(number: number) {
  const repo = S.getRepo("me", "proj")!;
  return S.listEvents(0, repo.id, 10000).filter(
    (e) =>
      e.type === "pull_request.github_sync_finished" &&
      JSON.parse(e.payload).number === number,
  );
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  job = await import("./github-pull-sync-job.ts");
  mergeSync = await import("./github-merge-sync.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-ghsync-job-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("a sync request queues one job and reuses it until it finishes", async () => {
  const { number } = await openGithubLinkedPull();
  expect(svc.pulls.githubSyncJob("me/proj", number)).toBeNull();

  const first = svc.pulls.syncGithubPull("me/proj", number);
  expect(first).toMatchObject({ status: "queued", error: null });
  expect(svc.pulls.syncGithubPull("me/proj", number).id).toBe(first.id);

  const claimed = claim();
  expect(claimed.id).toBe(first.id);
  expect(svc.pulls.syncGithubPull("me/proj", number).id).toBe(first.id);
  await job.runGithubPullSyncJob(claimed, okDeps);

  expect(svc.pulls.githubSyncJob("me/proj", number)).toMatchObject({
    id: first.id,
    status: "done",
  });
  expect(syncFinishedEvents(number)).toHaveLength(1);
  expect(await svc.pulls.githubStatus("me/proj", number)).toMatchObject({
    mergeable: "mergeable",
  });

  const second = svc.pulls.syncGithubPull("me/proj", number);
  expect(second.id).not.toBe(first.id);
  expect(second.status).toBe("queued");
  await job.runGithubPullSyncJob(claim(), okDeps);
});

test("a failed GitHub read fails the job with its error", async () => {
  const { number } = await openGithubLinkedPull();
  svc.pulls.syncGithubPull("me/proj", number);
  await job.runGithubPullSyncJob(claim(), {
    ...okDeps,
    fetchStatus: async () => {
      throw new Error("gh: rate limited");
    },
  });
  expect(svc.pulls.githubSyncJob("me/proj", number)).toMatchObject({
    status: "failed",
    error: "status: gh: rate limited",
  });
  expect(syncFinishedEvents(number)).toHaveLength(1);
});

test("a closed or archived PR is synced on request, outside the periodic sync", async () => {
  const { number, issueId } = await openGithubLinkedPull();
  await svc.pulls.update("me/proj", number, { state: "closed" });
  svc.pulls.archive("me/proj", number);
  expect(S.githubSyncRows().some((row) => row.issue_id === issueId)).toBe(
    false,
  );

  svc.pulls.syncGithubPull("me/proj", number);
  await job.runGithubPullSyncJob(claim(), {
    ...okDeps,
    fetchStatus: async () => ({ ...STATUS, state: "closed" }),
  });
  expect(svc.pulls.githubSyncJob("me/proj", number)).toMatchObject({
    status: "done",
  });
  expect(await svc.pulls.githubStatus("me/proj", number)).toMatchObject({
    state: "closed",
  });
});

test("a PR without a GitHub link is refused, and a job whose link went away fails", async () => {
  const { number } = await openGithubLinkedPull();
  svc.pulls.syncGithubPull("me/proj", number);
  svc.pulls.unlinkGithubPull("me/proj", number);

  expect(() => svc.pulls.syncGithubPull("me/proj", number)).toThrow(
    expect.objectContaining({ status: 404 }),
  );
  await job.runGithubPullSyncJob(claim(), okDeps);
  expect(svc.pulls.githubSyncJob("me/proj", number)).toMatchObject({
    status: "failed",
    error: "PR has no linked GitHub PR",
  });
});

test("a merge seen by two overlapping syncs is recorded and announced once", async () => {
  const { issueId } = await openGithubLinkedPull();
  // Both syncs read the link before either recorded the merge.
  const link = S.githubSyncRow(issueId)!;
  const deps = {
    fetchMergeStatus: async () => ({
      merged: true,
      mergedAt: "2026-07-02T00:00:00Z",
      mergedByLogin: "octocat",
    }),
  };
  const results = await Promise.all([
    mergeSync.syncGithubPullMerge(link, deps),
    mergeSync.syncGithubPullMerge(link, deps),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
});
