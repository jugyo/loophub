import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isServiceError } from "./errors.ts";
import {
  pinnedBaseSha,
  workflowRunProgress,
  worktreeHead,
} from "./workflow-run-progress.ts";

// The module is a set of near-pure git observations over a worktree; it never touches the store, so
// these tests need only a throwaway git repo, not an isolated LOOPHUB_HOME/DB.

let REPO: string;

function gitAt(args: string[]): string {
  const result = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commit(name: string, content: string): string {
  writeFileSync(join(REPO, name), content);
  gitAt(["add", name]);
  gitAt(["commit", "-q", "-m", `add ${name}`]);
  return gitAt(["rev-parse", "HEAD"]);
}

beforeAll(() => {
  REPO = mkdtempSync(join(tmpdir(), "lh-run-progress-"));
  gitAt(["init", "-q", "-b", "main"]);
  gitAt(["config", "user.email", "t@example.local"]);
  gitAt(["config", "user.name", "tester"]);
  commit("README.md", "hello\n");
});

afterAll(() => {
  rmSync(REPO, { recursive: true, force: true });
});

test("worktreeHead returns HEAD, and rejects when it cannot resolve", async () => {
  expect(await worktreeHead(REPO)).toBe(gitAt(["rev-parse", "HEAD"]));

  const nonRepo = mkdtempSync(join(tmpdir(), "lh-run-progress-empty-"));
  try {
    await expect(worktreeHead(nonRepo)).rejects.toSatisfy(
      (e) => isServiceError(e) && e.status === 422,
    );
  } finally {
    rmSync(nonRepo, { recursive: true, force: true });
  }
});

test("pinnedBaseSha resolves the merge-base of base branch and head", async () => {
  const base = gitAt(["rev-parse", "HEAD"]);
  gitAt(["checkout", "-q", "-b", "feature"]);
  const head = commit("feature.txt", "work\n");

  expect(await pinnedBaseSha(REPO, "main", head)).toBe(base);
  gitAt(["checkout", "-q", "main"]);
});

test("workflowRunProgress: head equal to base is not ahead and Execute is incomplete", async () => {
  const progress = await workflowRunProgress({
    worktree: REPO,
    baseBranch: "main",
    latestReview: null,
  });
  expect(progress.currentHead).toBe(gitAt(["rev-parse", "HEAD"]));
  expect(progress.headAheadOfBase).toBe(false);
  expect(progress.steps.execute.complete).toBe(false);
  expect(progress.steps.execute.missing).toContain("head equals base");
});

test("workflowRunProgress: head ahead of base completes Execute; a review pinned to head completes Verify", async () => {
  gitAt(["checkout", "-q", "-b", "ahead"]);
  const head = commit("ahead.txt", "more\n");

  const unverified = await workflowRunProgress({
    worktree: REPO,
    baseBranch: "main",
    latestReview: null,
  });
  expect(unverified.headAheadOfBase).toBe(true);
  expect(unverified.steps.execute.complete).toBe(true);
  expect(unverified.steps.verify.complete).toBe(false);

  const verified = await workflowRunProgress({
    worktree: REPO,
    baseBranch: "main",
    latestReview: { id: 1, event: "pass", headSha: head },
  });
  expect(verified.steps.verify.complete).toBe(true);
  expect(verified.steps.verify.latest_review).toMatchObject({
    id: 1,
    event: "pass",
    fresh: true,
  });

  gitAt(["checkout", "-q", "main"]);
});
