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
    `Workflow run ${run.id} requires human guidance: Rework limit reached.`,
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
