import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-diff-feedback-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

const REPO = "me/diff-feedback";
const PARENT_SESSION = "11111111-1111-4111-8111-111111111111";
const EXECUTE_SESSION = "22222222-2222-4222-8222-222222222222";
const HUMAN_SESSION = "33333333-3333-4333-8333-333333333333";

let svc: typeof import("../service.ts");
let S: typeof import("../store.ts");
let repoPath: string;
let repoId: number;
let prNumber: number;
let baseSha: string;
let headSha: string;
let runId: number;

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function createThread(body: string, sessionId: string = HUMAN_SESSION) {
  return svc.diffFeedback.create(
    REPO,
    prNumber,
    {
      baseSha,
      headSha,
      path: "a.txt",
      side: "RIGHT",
      startLine: 2,
      endLine: 2,
      body,
    },
    sessionId,
  );
}

function runEvents() {
  return S.eventsForWorkflowRun(repoId, runId).filter(
    (event) => event.type === "workflow_run.diff_feedback",
  );
}

beforeAll(async () => {
  svc = await import("../service.ts");
  S = await import("../store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-diff-feedback-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  baseSha = git(["rev-parse", "HEAD"]);
  git(["checkout", "-qb", "feature"]);
  writeFileSync(join(repoPath, "a.txt"), "one\nchanged\nthree\nfour\nfive\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature"]);
  headSha = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);

  await svc.repos.create({ path: repoPath, name: REPO });
  repoId = (await svc.repos.get(REPO)).id;
  const pull = await svc.pulls.create(REPO, {
    title: "feedback target",
    body: "",
    head: "feature",
    base: "main",
  });
  prNumber = pull.number;

  S.registerAgentSession(HUMAN_SESSION, "me", "human-runtime");
  S.registerAgentSession(
    EXECUTE_SESSION,
    "claude-code",
    "execute-runtime",
    "executor #1-1",
  );
  const workflow = S.createWorkflow({
    name: "diff-feedback-workflow",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  runId = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId,
    issueNumber: prNumber,
    prNumber,
    status: "running",
    currentStep: "execute",
    parentSessionId: PARENT_SESSION,
    costIncrementUsd: 10,
    costLimitUsd: 10,
  }).id;
  S.appendWorkflowRunStepSession(runId, "execute", EXECUTE_SESSION);
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("a diff comment records its anchor on the domain event, not a copy of itself", async () => {
  const created = await createThread("Why is this changed?");
  const event = S.listEvents(0, repoId, 100).find(
    (row) => row.type === "pull_request.diff_feedback_created",
  );

  expect(event).toBeDefined();
  // The commenter is the event's own actor, and the body stays in the comment row the ids name.
  expect(event!.actor).toBe("me");
  expect(JSON.parse(event!.payload)).toEqual({
    number: prNumber,
    thread_id: created.thread.id,
    comment_id: created.comment.id,
    path: "a.txt",
    side: "RIGHT",
    start_line: 2,
    end_line: 2,
  });
});

test("the comment is projected onto the running workflow run for its PR", () => {
  const projected = runEvents();
  expect(projected).toHaveLength(1);
  expect(JSON.parse(projected[0].payload)).toMatchObject({
    id: runId,
    pr_number: prNumber,
    parent_session_id: PARENT_SESSION,
    source_event_type: "pull_request.diff_feedback_created",
  });
});

test("Execute reads the unanswered comment with the diff around its anchor", async () => {
  const pending = await svc.diffFeedback.pending(REPO, prNumber, runId);

  expect(pending.run).toBe(runId);
  expect(pending.threads).toHaveLength(1);
  expect(pending.threads[0]).toMatchObject({
    freshness: "current",
    anchor: { path: "a.txt", side: "RIGHT", start_line: 2, end_line: 2 },
  });
  expect(pending.threads[0].context).toContainEqual(
    expect.objectContaining({ text: "+changed", anchored: true }),
  );
  expect(pending.threads[0].context).toContainEqual(
    expect.objectContaining({ text: " three", anchored: false }),
  );
});

test("an Execute reply answers the comment without waking its own parent", async () => {
  const before = runEvents().length;
  const thread = (await svc.diffFeedback.list(REPO, prNumber)).threads[0];

  const replied = await svc.diffFeedback.reply(
    REPO,
    prNumber,
    thread.id,
    "Renamed for clarity.",
    EXECUTE_SESSION,
  );

  expect(replied.reply).toMatchObject({
    author: "executor #1-1",
    body: "Renamed for clarity.",
  });
  expect(runEvents()).toHaveLength(before);
  expect(
    (await svc.diffFeedback.pending(REPO, prNumber, runId)).threads,
  ).toEqual([]);
});

test("a supported reaction is stored once per actor and included with the comment", async () => {
  const thread = (await svc.diffFeedback.list(REPO, prNumber)).threads[0];
  const message = thread.messages[0];

  await svc.diffFeedback.react(REPO, prNumber, message.id, "👍", HUMAN_SESSION);
  await svc.diffFeedback.react(REPO, prNumber, message.id, "👍", HUMAN_SESSION);
  await svc.diffFeedback.react(
    REPO,
    prNumber,
    message.id,
    "👍",
    EXECUTE_SESSION,
  );

  expect(
    (await svc.diffFeedback.list(REPO, prNumber)).threads[0].messages[0]
      .reactions,
  ).toEqual([{ emoji: "👍", count: 2 }]);
  await expect(
    svc.diffFeedback.react(REPO, prNumber, message.id, "😈", HUMAN_SESSION),
  ).rejects.toThrow("unsupported diff feedback reaction");
});

test("a follow-up comment from outside the run becomes pending again", async () => {
  const thread = (await svc.diffFeedback.list(REPO, prNumber)).threads[0];
  const before = runEvents().length;

  await svc.diffFeedback.reply(
    REPO,
    prNumber,
    thread.id,
    "Still unclear.",
    HUMAN_SESSION,
  );

  expect(runEvents()).toHaveLength(before + 1);
  expect(
    (await svc.diffFeedback.pending(REPO, prNumber, runId)).threads.map(
      ({ id }) => id,
    ),
  ).toEqual([thread.id]);
});

test("a PR with no running workflow run only records the domain event", async () => {
  S.updateWorkflowRun(runId, { status: "completed" });
  const before = S.listEvents(0, repoId, 500).length;

  const created = await createThread("Late thought.");

  const events = S.listEvents(0, repoId, 500);
  expect(events).toHaveLength(before + 1);
  expect(events.at(-1)).toMatchObject({
    type: "pull_request.diff_feedback_created",
  });
  expect(created.comment.body).toBe("Late thought.");
});
