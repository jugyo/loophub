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
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: "parent-session",
  });
  return run.id;
}

function reviewEvents() {
  return S.listEvents(0, repoId, 200).filter(
    (e) => e.type === "pull_request.review_submitted",
  );
}

function runScopedReviewEvents() {
  return S.listEvents(0, repoId, 200).filter(
    (e) => e.type === "workflow_run.review_submitted",
  );
}

// A PR linked to an issue that carries structured acceptance criteria (#1895), so grades submitted
// on the PR review can be validated against the linked issue's enabled rubric. Returns the PR number
// and both public references and storage ids in display order.
async function newPullForRubric(
  title: string,
  criteria: string[],
): Promise<{
  prNumber: number;
  issueNumber: number;
  acRefs: string[];
  internalAcIds: number[];
}> {
  const issue = (await svc.issues.create("me/reviews", {
    title: `issue ${title}`,
    acceptance_criteria: criteria,
  })) as { number: number };
  git(["checkout", "-q", "main"]);
  const branch = `rubric-${title.replace(/\s+/g, "-")}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "change\n");
  git(["add", "-A"]);
  git(["commit", "-qm", branch]);
  git(["checkout", "-q", "main"]);
  const pull = await svc.pulls.create("me/reviews", {
    title,
    head: branch,
    base: "main",
    issue: issue.number,
  });
  const storedIssue = S.getIssue(repoId, issue.number)!;
  const storedCriteria = S.listAcceptanceCriteria(storedIssue.id);
  return {
    prNumber: pull.number,
    issueNumber: issue.number,
    acRefs: storedCriteria.map(
      (criterion) => `${issue.number}-${criterion.number}`,
    ),
    internalAcIds: storedCriteria.map((criterion) => criterion.id),
  };
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
  S.registerAgentSession(
    "reviewer-session",
    "codex",
    "reviewer-external",
    "reviewer",
  );
  S.registerAgentSession(
    "human-session",
    "me",
    "human-external",
    "human-reviewer",
  );
});

afterAll(() => {
  spawnSync("git", ["-C", repoPath, "worktree", "prune"], { encoding: "utf8" });
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("a human REQUEST_CHANGES carries review_id and the submission head on its source event", async () => {
  const pr = await newPull("human-emit");
  startRun(pr, "execute");
  const before = reviewEvents().length;

  // No verify session — a plain human session.
  const review = await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "REQUEST_CHANGES", body: "please fix" },
    "human-session",
  );

  const events = reviewEvents();
  expect(review.author_type).toBe("human");
  expect(events.length).toBe(before + 1);
  expect(JSON.parse(events.at(-1)!.payload)).toEqual({
    number: pr,
    state: "REQUEST_CHANGES",
    comments: 0,
    session_id: "human-session",
    review_id: review.id,
    submission_head_sha: review.head_sha,
    source_payload_version: 1,
  });
  // No run-scoped twin: the review row stays the sole verdict source and the run's subscription
  // picks the submission up from the source itself.
  expect(runScopedReviewEvents()).toEqual([]);
});

test("a review on a PR with no running run records the same source event", async () => {
  const pr = await newPull("no-run");
  const before = reviewEvents().length;

  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "REQUEST_CHANGES", body: "please fix" },
    "human-session",
  );

  expect(reviewEvents().length).toBe(before + 1);
  expect(runScopedReviewEvents()).toEqual([]);
});

test("review responses stay linked to their review and optional review comment", async () => {
  const pr = await newPull("linked-response");
  const review = await svc.reviews.create(
    "me/reviews",
    pr,
    {
      event: "REQUEST_CHANGES",
      body: "please fix",
      comments: [{ path: "base.txt", line: 1, body: "fix this line" }],
    },
    "reviewer-session",
  );
  const comment = svc.reviews.listComments("me/reviews", pr).at(-1)!;
  expect(svc.reviews.get("me/reviews", pr, review.id)).toMatchObject({
    review: { id: review.id, author_type: "agent", body: "please fix" },
    comments: [
      {
        id: comment.id,
        pull_request_review_id: review.id,
        author_type: "agent",
        body: "fix this line",
      },
    ],
  });
  S.registerAgentSession(
    "executor-session",
    "codex",
    "executor-external",
    "executor",
  );

  const response = svc.reviews.createResponse(
    "me/reviews",
    pr,
    {
      reviewId: review.id,
      reviewCommentId: comment.id,
      body: "fixed in the latest commit",
    },
    "executor-session",
  );

  expect(response).toMatchObject({
    pull_request_review_id: review.id,
    pull_request_review_comment_id: comment.id,
    body: "fixed in the latest commit",
    user: { login: "executor" },
  });
  expect(svc.reviews.listResponses("me/reviews", pr, review.id)).toEqual([
    response,
  ]);
});

test("review responses reject a comment from another review", async () => {
  const pr = await newPull("mismatched-response");
  const first = await svc.reviews.create(
    "me/reviews",
    pr,
    {
      event: "REQUEST_CHANGES",
      comments: [{ path: "base.txt", line: 1, body: "first" }],
    },
    "reviewer-session",
  );
  const comment = svc.reviews.listComments("me/reviews", pr).at(-1)!;
  const second = await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "COMMENT", body: "second" },
    "reviewer-session",
  );

  expect(() =>
    svc.reviews.createResponse(
      "me/reviews",
      pr,
      {
        reviewId: second.id,
        reviewCommentId: comment.id,
        body: "wrong parent",
      },
      "executor-session",
    ),
  ).toThrow(`review comment #${comment.id} not found on review #${second.id}`);
  expect(first.id).not.toBe(second.id);
});

test("a FEEDBACK review carries review_id on its source event too", async () => {
  const pr = await newPull("feedback-emit");
  startRun(pr, "execute");
  const before = reviewEvents().length;

  // Non-blocking out-of-band human feedback: must still route to Execute.
  const review = await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "FEEDBACK", body: "consider this" },
    "human-session",
  );

  const events = reviewEvents();
  expect(events.length).toBe(before + 1);
  expect(JSON.parse(events.at(-1)!.payload)).toEqual({
    number: pr,
    state: "FEEDBACK",
    comments: 0,
    session_id: "human-session",
    review_id: review.id,
    submission_head_sha: review.head_sha,
    source_payload_version: 1,
  });
});

test("a FEEDBACK review is gate-neutral: it does not block merge and does not pass", async () => {
  const pr = await newPull("feedback-gate");

  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "FEEDBACK", body: "consider this" },
    "human-session",
  );

  const detail = await svc.pulls.get("me/reviews", pr);
  // The gate ignores FEEDBACK → unreviewed (not mergeable-by-itself), but not blocked either.
  expect(detail.review_gate).toEqual({
    reviewed: false,
    passed: false,
    head_sha: null,
    blocking_reason: null,
  });
});

test("a non-substantive COMMENT review notifies no run even with one running", async () => {
  const pr = await newPull("comment-only");
  startRun(pr, "execute");
  const before = reviewEvents().length;

  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "COMMENT", body: "fyi" },
    "human-session",
  );

  // Every review records the same source event; its verdict lives on the review row, and a
  // COMMENT is not one the reconcile acts on. Nothing run-scoped is written for it.
  expect(reviewEvents().length).toBe(before + 1);
  expect(JSON.parse(reviewEvents().at(-1)!.payload)).toMatchObject({
    state: "COMMENT",
  });
  expect(runScopedReviewEvents()).toEqual([]);
});

test("gate goes blocked on REQUEST_CHANGES and open when a later PASS supersedes it", async () => {
  const pr = await newPull("gate");

  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "REQUEST_CHANGES", body: "please fix" },
    "human-session",
  );
  let detail = await svc.pulls.get("me/reviews", pr);
  expect(detail.review_gate.reviewed).toBe(true);
  expect(detail.review_gate.passed).toBe(false);
  expect(detail.review_gate.blocking_reason).toBe("request_changes");

  // A Verify PASS supersedes the human request_changes (#1934).
  await svc.reviews.create(
    "me/reviews",
    pr,
    { event: "PASS", body: "all good" },
    "verify-session",
  );
  detail = await svc.pulls.get("me/reviews", pr);
  expect(detail.review_gate.passed).toBe(true);
  expect(detail.review_gate.blocking_reason).toBeNull();
});

test("--ac-results records a grade per enabled criterion on the review row (#1895)", async () => {
  const { prNumber, acRefs, internalAcIds } = await newPullForRubric(
    "grade-ok",
    ["alpha", "beta"],
  );
  const review = await svc.reviews.create("me/reviews", prNumber, {
    event: "REQUEST_CHANGES",
    body: "beta not met",
    acResults: [
      { criterion_id: acRefs[0], verdict: "pass" },
      { criterion_id: acRefs[1], verdict: "fail", note: "missing X" },
    ],
  });
  const grades = S.listReviewAcResults(review.id);
  expect(grades.map((g) => [g.criterion_id, g.verdict, g.note])).toEqual([
    [internalAcIds[0], "pass", ""],
    [internalAcIds[1], "fail", "missing X"],
  ]);
});

test("qualified issue-local AC references resolve to storage ids", async () => {
  const { prNumber, acRefs, internalAcIds } = await newPullForRubric(
    "grade-qualified",
    ["alpha", "beta"],
  );
  const review = await svc.reviews.create("me/reviews", prNumber, {
    event: "PASS",
    body: "all met",
    acResults: [
      { criterion_id: acRefs[0], verdict: "pass" },
      { criterion_id: acRefs[1], verdict: "pass" },
    ],
  });
  expect(S.listReviewAcResults(review.id).map((r) => r.criterion_id)).toEqual(
    internalAcIds,
  );
  expect(review.ac_results.map((result) => result.criterion_id)).toEqual(
    acRefs,
  );
});

test("internal criterion ids are rejected by the review service boundary", async () => {
  const { prNumber, internalAcIds } = await newPullForRubric(
    "grade-internal-id",
    ["only"],
  );
  await expect(
    svc.reviews.create("me/reviews", prNumber, {
      acResults: [
        {
          // @ts-expect-error Review input can arrive from untyped external JSON.
          criterion_id: internalAcIds[0],
          verdict: "pass",
        },
      ],
    }),
  ).rejects.toThrow(/requires criterion_id as <issue-number>-<ac-number>/);
});

test("qualified AC references reject a different issue and a missing number", async () => {
  const { prNumber, issueNumber } = await newPullForRubric(
    "grade-qualified-errors",
    ["only"],
  );
  await expect(
    svc.reviews.create("me/reviews", prNumber, {
      acResults: [{ criterion_id: `${issueNumber + 999}-1`, verdict: "pass" }],
    }),
  ).rejects.toThrow(/issue #\d+ not found/);
  await expect(
    svc.reviews.create("me/reviews", prNumber, {
      acResults: [{ criterion_id: `${issueNumber}-2`, verdict: "pass" }],
    }),
  ).rejects.toThrow(/not found/);
});

test("a PASS contradicted by a failing grade is soft-warned, not rejected (#1896)", async () => {
  const { prNumber, acRefs } = await newPullForRubric("grade-contradiction", [
    "alpha",
    "beta",
  ]);
  const review = await svc.reviews.create("me/reviews", prNumber, {
    event: "PASS",
    body: "lgtm",
    acResults: [
      { criterion_id: acRefs[0], verdict: "pass" },
      { criterion_id: acRefs[1], verdict: "fail", note: "missing X" },
    ],
  });
  expect(review.warnings).toEqual([
    "event=PASS was submitted with 1 failing acceptance criterion grade(s); a pass requires every criterion to pass",
  ]);
  // The review and its grades are recorded as submitted — the warning is visible, not corrective.
  expect(review.state).toBe("PASS");
  expect(S.listReviewAcResults(review.id).map((g) => g.verdict)).toEqual([
    "pass",
    "fail",
  ]);
});

test("a consistent verdict carries no warning (#1896)", async () => {
  const { prNumber, acRefs } = await newPullForRubric("grade-consistent", [
    "alpha",
    "beta",
  ]);
  const passed = await svc.reviews.create("me/reviews", prNumber, {
    event: "PASS",
    body: "lgtm",
    acResults: [
      { criterion_id: acRefs[0], verdict: "pass" },
      { criterion_id: acRefs[1], verdict: "pass" },
    ],
  });
  expect(passed.warnings).toEqual([]);
  const changes = await svc.reviews.create("me/reviews", prNumber, {
    event: "REQUEST_CHANGES",
    body: "beta not met",
    acResults: [
      { criterion_id: acRefs[0], verdict: "pass" },
      { criterion_id: acRefs[1], verdict: "fail", note: "missing X" },
    ],
  });
  expect(changes.warnings).toEqual([]);
});

test("omitting --ac-results is the holistic fallback: no grade rows (#1895)", async () => {
  const { prNumber } = await newPullForRubric("grade-holistic", ["only"]);
  const review = await svc.reviews.create("me/reviews", prNumber, {
    event: "PASS",
    body: "lgtm",
  });
  expect(S.listReviewAcResults(review.id)).toEqual([]);
});

test("a criterion outside the linked issue's enabled rubric is rejected, not corrected (#1895)", async () => {
  const { prNumber, acRefs } = await newPullForRubric("grade-foreign", ["one"]);
  const otherIssue = (await svc.issues.create("me/reviews", {
    title: "other rubric",
    acceptance_criteria: ["other"],
  })) as { number: number };
  const before = S.getIssue(repoId, prNumber);
  await expect(
    svc.reviews.create("me/reviews", prNumber, {
      event: "PASS",
      body: "x",
      acResults: [
        { criterion_id: acRefs[0], verdict: "pass" },
        { criterion_id: `${otherIssue.number}-1`, verdict: "pass" },
      ],
    }),
  ).rejects.toThrow(/is not the issue linked to this pull request/);
  // The rejected submission wrote nothing — no partial review row survives.
  expect(S.listReviews(before!.id)).toHaveLength(0);
});

test("a disabled criterion is not gradable; grading only the enabled set succeeds (#1895)", async () => {
  const { prNumber, acRefs, internalAcIds } = await newPullForRubric(
    "grade-disabled",
    ["keep", "drop"],
  );
  S.setAcceptanceCriterionEnabled(internalAcIds[1], false);
  await expect(
    svc.reviews.create("me/reviews", prNumber, {
      event: "PASS",
      body: "x",
      acResults: [
        { criterion_id: acRefs[0], verdict: "pass" },
        { criterion_id: acRefs[1], verdict: "pass" },
      ],
    }),
  ).rejects.toThrow(/not an enabled acceptance criterion/);
  const review = await svc.reviews.create("me/reviews", prNumber, {
    event: "PASS",
    body: "ok",
    acResults: [{ criterion_id: acRefs[0], verdict: "pass" }],
  });
  expect(S.listReviewAcResults(review.id).map((g) => g.criterion_id)).toEqual([
    internalAcIds[0],
  ]);
});

test("a partial (undersized) grade set is rejected — every enabled criterion must be graded (#1895)", async () => {
  const { prNumber, acRefs } = await newPullForRubric("grade-partial", [
    "a",
    "b",
  ]);
  await expect(
    svc.reviews.create("me/reviews", prNumber, {
      event: "PASS",
      body: "x",
      acResults: [{ criterion_id: acRefs[0], verdict: "pass" }],
    }),
  ).rejects.toThrow(/grade every enabled acceptance criterion/);
});

test("a duplicate grade for one criterion is rejected (#1895)", async () => {
  const { prNumber, acRefs } = await newPullForRubric("grade-dup", ["a", "b"]);
  await expect(
    svc.reviews.create("me/reviews", prNumber, {
      event: "PASS",
      body: "x",
      acResults: [
        { criterion_id: acRefs[0], verdict: "pass" },
        { criterion_id: acRefs[0], verdict: "fail" },
      ],
    }),
  ).rejects.toThrow(/duplicate ac-result/);
});

test("an invalid verdict is rejected (#1895)", async () => {
  const { prNumber, acRefs } = await newPullForRubric("grade-verdict", ["a"]);
  await expect(
    svc.reviews.create("me/reviews", prNumber, {
      event: "PASS",
      body: "x",
      acResults: [{ criterion_id: acRefs[0], verdict: "maybe" }],
    }),
  ).rejects.toThrow(/verdict must be 'pass' or 'fail'/);
});
