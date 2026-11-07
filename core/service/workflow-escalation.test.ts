import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-escalation-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function createRun(name: string, withPr = true) {
  const repo = S.createRepo(name, HOME);
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Needs a decision",
    "body",
    "me",
  );
  const pr = withPr
    ? S.createIssue(repo.id, "pull", "Implementation", "body", "me")
    : null;
  if (pr) S.createPull(pr.id, "feature", "main", "head", issue.id);
  const workflow = S.createWorkflow({
    name: `workflow-${repo.id}`,
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: issue.number + 1,
    status: "running",
    currentStep: "execute",
    parentSessionId: "11111111-1111-4111-8111-111111111111",
    costIncrementUsd: 10,
    costLimitUsd: 10,
  });
  return { repo, issue, pr: pr!, run };
}

test("escalateHuman records one PR comment across replays", () => {
  const { repo, pr, run } = createRun("me/escalation");

  const first = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: "  Rework limit reached.  " },
    run.parent_session_id,
  );
  const replay = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: "Rework limit reached." },
    run.parent_session_id,
  );

  expect(first).toMatchObject({
    ok: true,
    run: run.id,
    pr: pr.number,
    reason: "Rework limit reached.",
    effects: {
      pr_comment: { status: "completed" },
    },
  });
  expect(replay).toMatchObject({
    ok: true,
    effects: {
      pr_comment: { status: "already_completed" },
    },
  });
  expect(S.listComments(pr.id)).toHaveLength(1);
  expect(S.listComments(pr.id)[0].body).toBe(
    `Workflow run ${run.id} requires human guidance.\n\nRework limit reached.`,
  );
});

// The parent's session name embeds the issue title, so the comment carries the role name and
// leaves the run id to the body.
test("escalateHuman attributes the PR comment to the orchestrator", () => {
  const { repo, pr, run } = createRun("me/escalation-author");
  S.registerAgentSession(
    run.parent_session_id!,
    "lh-workflow",
    run.parent_session_id!,
    "Workflow #1 Needs a decision",
    "claude-code",
    "dev",
  );

  svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: "Rework limit reached." },
    run.parent_session_id,
  );

  const [comment] = S.listComments(pr.id);
  expect(comment).toMatchObject({
    author: "orchestrator",
    author_type: "agent",
  });
  expect(comment.body).toContain(`Workflow run ${run.id}`);
});

test("escalateHuman keeps the Markdown structure of the comment body", () => {
  const { repo, pr, run } = createRun("me/escalation-markdown");
  const reason = [
    "## Background",
    "",
    "仕様の前提が未確定。",
    "",
    "## Options",
    "",
    "- 現行仕様を維持する",
    "- 変更する",
    "",
    "```sh",
    "lh workflow status",
    "```",
  ].join("\n");

  const result = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: `\r\n${reason.replaceAll("\n", "\r\n")}\r\n` },
    run.parent_session_id,
  );

  expect(result.reason).toBe(reason);
  expect(S.listComments(pr.id)[0]?.body).toBe(
    `Workflow run ${run.id} requires human guidance.\n\n${reason}`,
  );
});

test("escalateHuman fails visibly when the run PR is missing", () => {
  const { repo, run } = createRun("me/escalation-missing-pr", false);

  expect(() =>
    svc.workflowEscalation.escalateHuman(
      repo.full_name,
      { run: run.id, reason: "The decision needs human guidance." },
      run.parent_session_id,
    ),
  ).toThrowError(/linked PR #\d+ not found/);
});

test("escalateHuman records the parent's organized decision context", () => {
  const { repo, pr, run } = createRun("me/escalation-organized");
  const reason =
    "Background: 仕様の前提が未確定。 Missing information: 対象環境。 Options: 現行仕様を維持するか変更する。 Decision points: 人間が選択肢を決める。";

  const result = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason },
    run.parent_session_id,
  );

  expect(result.ok).toBe(true);
  expect(S.listComments(pr.id)[0]?.body).toContain(reason);
});

// The four-section body the parent contract asks for regularly exceeds the cap, and rejecting it
// held the run instead of notifying anyone.
test("escalateHuman trims a long comment body instead of rejecting it", () => {
  const { repo, pr, run } = createRun("me/escalation-long");

  const result = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: "y".repeat(5001) },
    run.parent_session_id,
  );

  expect(result.ok).toBe(true);
  expect(result.reason).toBe(`${"y".repeat(4999)}…`);
  expect(S.listComments(pr.id)[0]?.body).toContain(`${"y".repeat(4999)}…`);
});

test("escalateHuman exposes failure and does not replay a pending effect", () => {
  const { repo, pr, run } = createRun("me/escalation-partial");

  const failed = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: "Comments are unavailable." },
    run.parent_session_id,
    {
      createComment() {
        throw new Error("comment unavailable");
      },
    },
  );
  const replay = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: "Comments are unavailable." },
    run.parent_session_id,
  );

  expect(failed).toMatchObject({
    ok: false,
    effects: {
      pr_comment: { status: "failed", error: "comment unavailable" },
    },
  });
  expect(replay).toMatchObject({
    ok: false,
    effects: { pr_comment: { status: "pending" } },
  });
  expect(S.listComments(pr.id)).toHaveLength(0);
});

test("escalateHuman records the choices as structured escalation data", () => {
  const { repo, pr, run } = createRun("me/escalation-options");

  const result = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    {
      run: run.id,
      reason: "Background: 前提が未確定。",
      options: [
        " 現行仕様を維持する ",
        "",
        "仕様を\n変更する",
        "現行仕様を維持する",
      ],
    },
    run.parent_session_id,
  );

  expect(result.options).toEqual(["現行仕様を維持する", "仕様を 変更する"]);
  const [comment] = svc.comments.list(repo.full_name, pr.number);
  expect(comment.escalation).toEqual({
    options: ["現行仕様を維持する", "仕様を 変更する"],
    answer: null,
    answered_at: null,
    superseded: false,
  });
});

test("answer posts the chosen option as the human's PR comment once", () => {
  const { repo, pr, run } = createRun("me/escalation-answer");
  svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: "Pick one.", options: ["A 案", "B 案"] },
    run.parent_session_id,
  );
  const [escalationComment] = S.listComments(pr.id);

  expect(() =>
    svc.workflowEscalation.answer(
      repo.full_name,
      pr.number,
      escalationComment.id,
      "C 案",
    ),
  ).toThrowError(/not one of/);

  const answered = svc.workflowEscalation.answer(
    repo.full_name,
    pr.number,
    escalationComment.id,
    "B 案",
  );

  expect(answered).toMatchObject({ answer: "B 案", superseded: false });
  const comments = S.listComments(pr.id);
  expect(comments).toHaveLength(2);
  expect(comments[1]).toMatchObject({ author: "me", author_type: "human" });
  expect(comments[1].body).toContain(`#${escalationComment.id}`);
  expect(comments[1].body).toContain("B 案");
  const event = S.listEvents(0, repo.id, 1000).findLast(
    (row) => row.type === "pull_request.commented",
  );
  expect(JSON.parse(event!.payload)).toMatchObject({
    number: pr.number,
    comment_id: comments[1].id,
    author_type: "human",
  });
  expect(() =>
    svc.workflowEscalation.answer(
      repo.full_name,
      pr.number,
      escalationComment.id,
      "A 案",
    ),
  ).toThrowError(/already answered/);
  expect(S.listComments(pr.id)).toHaveLength(2);
});

test("a newer escalation for the run supersedes the earlier one", () => {
  const { repo, pr, run } = createRun("me/escalation-superseded");
  svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: "First question.", options: ["A", "B"] },
    run.parent_session_id,
  );
  svc.comments.createHumanForPull(repo.full_name, pr.number, "unrelated");
  const [first] = svc.comments.list(repo.full_name, pr.number);
  expect(first.escalation?.superseded).toBe(false);

  svc.workflowEscalation.escalateHuman(
    repo.full_name,
    { run: run.id, reason: "Second question.", options: ["C", "D"] },
    run.parent_session_id,
  );

  const listed = svc.comments.list(repo.full_name, pr.number);
  expect(listed.map((comment) => comment.escalation?.superseded)).toEqual([
    true,
    undefined,
    false,
  ]);
  expect(() =>
    svc.workflowEscalation.answer(repo.full_name, pr.number, first.id, "A"),
  ).toThrowError(/superseded/);
});
