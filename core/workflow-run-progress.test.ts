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

// spawnSync is used only for the #39 repro guard (bare merge-tree must still fail under git).

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
  expect(progress.hasEffectiveDiff).toBe(false);
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
  expect(unverified.hasEffectiveDiff).toBe(true);
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

test("workflowRunProgress: commits with no effective diff stay distinguishable from merge-ready work", async () => {
  gitAt(["checkout", "-q", "-b", "empty-diff"]);
  commit("empty-diff.txt", "temporary\n");
  gitAt(["rm", "empty-diff.txt"]);
  gitAt(["commit", "-q", "-m", "remove empty-diff.txt"]);

  const progress = await workflowRunProgress({
    worktree: REPO,
    baseBranch: "main",
    latestReview: null,
  });

  expect(progress.headAheadOfBase).toBe(true);
  expect(progress.hasEffectiveDiff).toBe(false);
  gitAt(["checkout", "-q", "main"]);
});

test("workflowRunProgress reports a conflict between the current head and base", async () => {
  gitAt(["checkout", "-q", "-b", "conflicting"]);
  commit("conflict.txt", "feature\n");
  gitAt(["checkout", "-q", "main"]);
  commit("conflict.txt", "base\n");
  gitAt(["checkout", "-q", "conflicting"]);

  const progress = await workflowRunProgress({
    worktree: REPO,
    baseBranch: "main",
    latestReview: null,
  });

  expect(progress.headAheadOfBase).toBe(true);
  expect(progress.mergeConflict).toBe(true);
});

test("workflowRunProgress does not treat rewound or diverged HEAD as ahead of a review", async () => {
  gitAt(["checkout", "-q", "main"]);
  gitAt(["checkout", "-q", "-b", "review-line"]);
  const first = commit("review-first.txt", "first\n");
  const reviewed = commit("review-second.txt", "second\n");
  gitAt(["reset", "--hard", first]);

  const rewound = await workflowRunProgress({
    worktree: REPO,
    baseBranch: "main",
    latestReview: { id: 2, event: "request_changes", headSha: reviewed },
  });
  expect(rewound.headAheadOfBase).toBe(true);
  expect(rewound.headAheadOfLatestReview).toBe(false);
  expect(rewound.steps.execute.complete).toBe(false);

  gitAt(["checkout", "-q", "main"]);
  gitAt(["checkout", "-q", "-b", "diverged"]);
  commit("diverged.txt", "other work\n");
  const diverged = await workflowRunProgress({
    worktree: REPO,
    baseBranch: "main",
    latestReview: { id: 2, event: "request_changes", headSha: reviewed },
  });
  expect(diverged.headAheadOfBase).toBe(true);
  expect(diverged.headAheadOfLatestReview).toBe(false);
  expect(diverged.steps.execute.complete).toBe(false);
});

test("workflowRunProgress keeps an unresolvable base visible with collision hints (#39 AC-3)", async () => {
  // Stray pseudo-ref with no real branch: error must name candidates and a fix, not only "missing".
  writeFileSync(join(REPO, ".git", "missing-base"), `${"0".repeat(40)}\n`);
  await expect(
    workflowRunProgress({
      worktree: REPO,
      baseBranch: "missing-base",
      latestReview: null,
    }),
  ).rejects.toSatisfy(
    (e) =>
      isServiceError(e) &&
      e.status === 422 &&
      /could not resolve Workflow base branch 'missing-base'/.test(e.message) &&
      /\$GIT_DIR\/missing-base/.test(e.message) &&
      /hint: pass refs\/heads\/missing-base/.test(e.message),
  );
});

// #39: a stray `$GIT_DIR/<base>` file makes bare `git merge-tree <base> <head>` fail with
// "refname is ambiguous". Progress must still complete when `refs/heads/<base>` is a real branch.
test("workflowRunProgress tolerates a shadowing $GIT_DIR/<base> pseudo-ref (#39)", async () => {
  gitAt(["checkout", "-q", "main"]);
  gitAt(["branch", "-f", "opencode", "main"]);
  gitAt(["checkout", "-q", "-b", "feature-over-opencode"]);
  const head = commit("over-opencode.txt", "work\n");
  writeFileSync(join(REPO, ".git", "opencode"), `${"0".repeat(40)}\n`);

  // Guard: bare name is still ambiguous for git itself.
  const bare = spawnSync(
    "git",
    ["-C", REPO, "merge-tree", "--write-tree", "opencode", head],
    {
      encoding: "utf8",
    },
  );
  expect(bare.status).not.toBe(0);
  expect(bare.stderr).toMatch(/ambiguous/i);

  const progress = await workflowRunProgress({
    worktree: REPO,
    baseBranch: "opencode",
    latestReview: null,
  });
  expect(progress.currentHead).toBe(head);
  expect(progress.headAheadOfBase).toBe(true);
  expect(progress.hasEffectiveDiff).toBe(true);
  expect(progress.mergeConflict).toBe(false);
  expect(progress.steps.execute.complete).toBe(true);

  expect(await pinnedBaseSha(REPO, "opencode", head)).toMatch(/^[0-9a-f]{40}$/);

  gitAt(["checkout", "-q", "main"]);
});
