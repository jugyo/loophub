import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

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

function createRun(name: string) {
  const repo = S.createRepo(name, HOME);
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Needs a decision",
    "body",
    "me",
  );
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
  return { repo, issue, run };
}

test("escalateHuman records one Issue comment across replays", () => {
  const { repo, issue, run } = createRun("me/escalation");

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
    issue: issue.number,
    reason: "Rework limit reached.",
    effects: {
      issue_comment: { status: "completed" },
    },
  });
  expect(replay).toMatchObject({
    ok: true,
    effects: {
      issue_comment: { status: "already_completed" },
    },
  });
  expect(S.listComments(issue.id)).toHaveLength(1);
  expect(S.listComments(issue.id)[0].body).toContain("Rework limit reached.");
});

test("escalateHuman can override the run Issue", () => {
  const { repo, issue, run } = createRun("me/escalation-override");
  const other = S.createIssue(
    repo.id,
    "issue",
    "Escalation target",
    "body",
    "me",
  );

  const result = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    {
      run: run.id,
      reason: "The decision belongs on the other Issue.",
      issue: other.number,
    },
    run.parent_session_id,
  );

  expect(result).toMatchObject({ ok: true, issue: other.number });
  expect(S.listComments(issue.id)).toHaveLength(0);
  expect(S.listComments(other.id)).toHaveLength(1);

  const replay = svc.workflowEscalation.escalateHuman(
    repo.full_name,
    {
      run: run.id,
      reason: "The decision belongs on the other Issue.",
    },
    run.parent_session_id,
  );
  expect(replay).toMatchObject({
    ok: true,
    issue: other.number,
    effects: {
      issue_comment: { status: "already_completed" },
    },
  });

  const third = S.createIssue(
    repo.id,
    "issue",
    "Different target",
    "body",
    "me",
  );
  expect(() =>
    svc.workflowEscalation.escalateHuman(
      repo.full_name,
      {
        run: run.id,
        reason: "The decision belongs on the other Issue.",
        issue: third.number,
      },
      run.parent_session_id,
    ),
  ).toThrowError(/already targets Issue/);
});

test("escalateHuman exposes failure and does not replay a pending effect", () => {
  const { repo, issue, run } = createRun("me/escalation-partial");

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
      issue_comment: { status: "failed", error: "comment unavailable" },
    },
  });
  expect(replay).toMatchObject({
    ok: false,
    effects: { issue_comment: { status: "pending" } },
  });
  expect(S.listComments(issue.id)).toHaveLength(0);
});
