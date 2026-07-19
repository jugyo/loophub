import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-reviews-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let repoPath: string;
let repoId: number;
let workflowId: number;

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
  if ((r.status ?? 0) !== 0) throw new Error(r.stderr || r.stdout);
  return r.stdout.trim();
}

async function newPull(title: string): Promise<number> {
  git(["checkout", "-q", "main"]);
  const branch = `feature-${title.replace(/\s+/g, "-")}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "change\n");
  git(["add", "-A"]);
  git(["commit", "-qm", branch]);
  git(["checkout", "-q", "main"]);
  const pull = await svc.pulls.create("me/reviews", {
    title,
    head: branch,
    base: "main",
  });
  return pull.number;
}

function startRun(prNumber: number, currentStep: string): number {
  const run = S.createWorkflowRun({
    workflowId,
    repoId,
    issueNumber: prNumber,
    prNumber,
    status: "running",
    currentStep,
    parentSessionId: "parent-session",
  });
  return run.id;
}

function reviewEvents() {
  return S.listEvents(0, repoId, 200).filter(
    (e) => e.type === "workflow_run.review_submitted",
  );
}

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-reviews-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "base.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  const repo = await svc.repos.create({ path: repoPath, name: "me/reviews" });
  repoId = repo.id;
  workflowId = S.createWorkflow({
    name: "wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  }).id;
});

afterAll(() => {
  spawnSync("git", ["-C", repoPath, "worktree", "prune"], { encoding: "utf8" });
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("a human REQUEST_CHANGES on a PR with a running run emits review_submitted with review_id", async () => {
  const pr = await newPull("human-emit");
  const runId = startRun(pr, "execute");
  const before = reviewEvents().length;

  // No verify session — a plain human session (as an ingested crit review would be).
  const review = await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "REQUEST_CHANGES", topic: "workflow", body: "please fix" },
    "human-session",
  );

  const events = reviewEvents();
  expect(events.length).toBe(before + 1);
  expect(JSON.parse(events.at(-1)!.payload)).toEqual({
    id: runId,
    number: pr,
    issue_number: pr,
    pr_number: pr,
    parent_session_id: "parent-session",
    session_id: "human-session",
    review_id: review.id,
  });
});

test("a substantive review on a PR with no running run does not emit review_submitted", async () => {
  const pr = await newPull("no-run");
  const before = reviewEvents().length;

  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "REQUEST_CHANGES", topic: "workflow", body: "please fix" },
    "human-session",
  );

  expect(reviewEvents().length).toBe(before);
});

test("a FEEDBACK review on a PR with a running run emits review_submitted with review_id", async () => {
  const pr = await newPull("feedback-emit");
  const runId = startRun(pr, "execute");
  const before = reviewEvents().length;

  // Non-blocking human/crit feedback (as `lh pr crit` now ingests it): must still route to Execute.
  const review = await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "FEEDBACK", topic: "workflow", body: "consider this" },
    "human-session",
  );

  const events = reviewEvents();
  expect(events.length).toBe(before + 1);
  expect(JSON.parse(events.at(-1)!.payload)).toEqual({
    id: runId,
    number: pr,
    issue_number: pr,
    pr_number: pr,
    parent_session_id: "parent-session",
    session_id: "human-session",
    review_id: review.id,
  });
});

test("a FEEDBACK review is gate-neutral: it does not block merge and does not pass", async () => {
  const pr = await newPull("feedback-gate");

  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "FEEDBACK", topic: "workflow", body: "consider this" },
    "human-session",
  );

  const detail = await svc.pulls.get("me/reviews", pr);
  // No topic bucket is formed → unreviewed (not mergeable-by-itself), but not blocked either.
  expect(detail.review_gate.reviewed).toBe(false);
  expect(detail.review_gate.all_topics_passed).toBe(false);
  expect(detail.review_gate.topics).toEqual([]);
});

test("a non-substantive COMMENT review never emits review_submitted even with a running run", async () => {
  const pr = await newPull("comment-only");
  startRun(pr, "execute");
  const before = reviewEvents().length;

  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "COMMENT", topic: "workflow", body: "fyi" },
    "human-session",
  );

  expect(reviewEvents().length).toBe(before);
});

test("gate goes blocked on REQUEST_CHANGES(workflow) and clean when a later PASS(workflow) supersedes it", async () => {
  const pr = await newPull("gate");

  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "REQUEST_CHANGES", topic: "workflow", body: "please fix" },
    "human-session",
  );
  let detail = await svc.pulls.get("me/reviews", pr);
  expect(detail.review_gate.reviewed).toBe(true);
  expect(detail.review_gate.all_topics_passed).toBe(false);

  // A Verify PASS on the same `workflow` topic supersedes the human request_changes.
  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "PASS", topic: "workflow", body: "all good" },
    "verify-session",
  );
  detail = await svc.pulls.get("me/reviews", pr);
  expect(detail.review_gate.all_topics_passed).toBe(true);
});
