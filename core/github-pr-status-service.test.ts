import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { GhPrStatus, GithubPrStatusDeps } from "./github.ts";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-gh-pr-status-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let DB: typeof import("./db.ts");
let repoPath: string;
let ghNumber = 2000;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  DB = await import("./db.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-gh-pr-status-repo-"));
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

// A PR exported to (and linked with) a GitHub PR — the state githubStatus operates on.
async function openGithubLinkedPull() {
  const branch = `feature-${ghNumber}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "y\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature work"]);
  git(["checkout", "-q", "main"]);
  const pr = (await svc.pulls.create("me/proj", {
    title: "feat",
    head: branch,
    base: "main",
  })) as { number: number };
  svc.pulls.recordGithubPull("me/proj", pr.number, {
    github_number: ghNumber++,
    url: `https://github.com/me/proj/pull/${pr.number}`,
  });
  return pr.number;
}

const SAMPLE: GhPrStatus = {
  state: "open",
  merged: false,
  mergeable: "conflicting",
  reviewDecision: "changes_requested",
  checks: "failure",
  comments: 3,
  reviews: 2,
  updatedAt: "2026-07-01T00:00:00Z",
};

function depsReturning(
  status: GhPrStatus,
  onCall: () => void = () => {},
): GithubPrStatusDeps {
  return {
    fetchStatus: async () => {
      onCall();
      return status;
    },
  };
}

test("githubStatus fetches via gh, maps to the wire shape, and caches it (#850)", async () => {
  const number = await openGithubLinkedPull();
  const wire = await svc.pulls.githubStatus(
    "me/proj",
    number,
    depsReturning(SAMPLE),
  );
  expect(wire).toMatchObject({
    state: "open",
    merged: false,
    mergeable: "conflicting",
    review_decision: "changes_requested",
    checks: "failure",
    comments: 3,
    reviews: 2,
    updated_at: "2026-07-01T00:00:00Z",
  });
  expect(typeof wire.synced_at).toBe("string");
});

test("githubStatus serves the cache within the TTL without calling gh again (#850)", async () => {
  const number = await openGithubLinkedPull();
  let calls = 0;
  const deps = depsReturning(SAMPLE, () => calls++);
  await svc.pulls.githubStatus("me/proj", number, deps);
  await svc.pulls.githubStatus("me/proj", number, deps);
  expect(calls).toBe(1);
});

test("githubStatus falls back to the stale cache when a past-TTL refetch fails (#850)", async () => {
  const number = await openGithubLinkedPull();
  // Seed the cache with a successful fetch, then backdate it past the TTL so the next call is a miss.
  await svc.pulls.githubStatus("me/proj", number, depsReturning(SAMPLE));
  const repo = await svc.repos.get("me/proj");
  const issueId = S.getIssue(repo!.id, number)!.id;
  DB.db.run("UPDATE github_pull_status SET synced_at = ? WHERE issue_id = ?", [
    "2000-01-01T00:00:00Z",
    issueId,
  ]);
  // The refetch fails, but the (now stale) cached snapshot is still returned rather than throwing.
  const failing: GithubPrStatusDeps = {
    fetchStatus: async () => {
      throw new Error("gh auth failed");
    },
  };
  const wire = await svc.pulls.githubStatus("me/proj", number, failing);
  expect(wire.state).toBe("open");
  expect(wire.synced_at).toBe("2000-01-01T00:00:00Z");
});

test("githubStatus 502s when gh fails and nothing is cached (#850)", async () => {
  const number = await openGithubLinkedPull();
  const failing: GithubPrStatusDeps = {
    fetchStatus: async () => {
      throw new Error("gh network error");
    },
  };
  await expect(
    svc.pulls.githubStatus("me/proj", number, failing),
  ).rejects.toThrow("failed to fetch GitHub PR status");
});

test("githubStatus 404s when the PR has no linked GitHub PR (#850)", async () => {
  const branch = "no-github-link";
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "z\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "work"]);
  git(["checkout", "-q", "main"]);
  const pr = (await svc.pulls.create("me/proj", {
    title: "no link",
    head: branch,
    base: "main",
  })) as { number: number };
  await expect(
    svc.pulls.githubStatus("me/proj", pr.number, depsReturning(SAMPLE)),
  ).rejects.toThrow("no linked GitHub PR");
});
