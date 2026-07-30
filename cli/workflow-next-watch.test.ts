import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-workflow-watch-"));
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "loophub.db");

const NODE_ARGS = [
  "--experimental-sqlite",
  "--disable-warning=ExperimentalWarning",
  "--import",
  "tsx",
  "cli/index.ts",
];

let S: typeof import("../core/store.ts");
let repoId: number;
let workflowId: number;

function runCli(args: string[]) {
  return spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    timeout: 10_000,
  });
}

function watchArgs(run: number) {
  return [
    "workflow",
    "next",
    String(run),
    "--repo",
    "me/workflow-watch",
    "--watch",
    "--json",
  ];
}

function runWatch(run: number) {
  return runCli(watchArgs(run));
}

// A run needs the Issue/PR rows `workflow next` observes. The PR's worktree is never provisioned,
// so HEAD stays unresolved and the state-derived decision here is always the same — what these
// tests assert is event delivery, not the reconcile rules (core/workflow-runs-service.test.ts).
function createRun(options: { started?: boolean } = {}): {
  run: number;
  issue: number;
  pr: number;
} {
  const issue = S.createIssue(repoId, "issue", "watch", "", "me");
  const prIssue = S.createIssue(repoId, "pull", "watch pr", "", "me");
  S.createPull(
    prIssue.id,
    `loophub/pr-${prIssue.number}`,
    "main",
    null,
    issue.id,
  );
  const run = S.createWorkflowRun({
    workflowId,
    repoId,
    issueNumber: issue.number,
    prNumber: prIssue.number,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 1,
    costLimitUsd: 1,
  }).id;
  // The run's start is the lower bound of its subscription, so every fixture records it exactly as
  // `workflow start` does. The one that leaves it out asserts the visible error that follows.
  if (options.started !== false) {
    S.emitEvent(repoId, "workflow_run.started", "me", {
      id: run,
      workflow_id: workflowId,
      issue_number: issue.number,
      pr_number: prIssue.number,
      session_id: null,
    });
  }
  return { run, issue: issue.number, pr: prIssue.number };
}

function runCursor(run: number): number {
  return S.getWorkflowRun(run)?.event_cursor ?? -1;
}

type BackgroundResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function startWatch(run: number): Promise<BackgroundResult> {
  const child = spawn(process.execPath, [...NODE_ARGS, ...watchArgs(run)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

beforeAll(async () => {
  S = await import("../core/store.ts");
  const repo = S.createRepo("me/workflow-watch", process.cwd());
  repoId = repo.id;
  workflowId = S.createWorkflow({
    name: "watch-test",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  }).id;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("lh workflow next --watch returns one event per call and resumes after it", () => {
  const { run } = createRun();
  S.emitEvent(repoId, "workflow_run.turn_done", "test", { id: run });
  S.emitEvent(repoId, "workflow_run.escalated", "test", {
    id: run,
    reason: "Need human guidance",
  });

  // The run's own start is its first wake: it is what tells the consumer to launch Execute.
  const started = runWatch(run);
  expect(JSON.parse(started.stdout).event).toMatchObject({
    type: "workflow_run.started",
  });

  const first = runWatch(run);
  const firstResult = JSON.parse(first.stdout);

  expect(first.error).toBeUndefined();
  expect(first.status).toBe(0);
  expect(firstResult.event).toMatchObject({ type: "workflow_run.turn_done" });
  expect(firstResult.observed.run).toBe(run);
  expect(typeof firstResult.action).toBe("string");

  // The cursor lives with the run, so the next call continues after the event already delivered.
  const next = JSON.parse(runWatch(run).stdout);
  expect(next.event).toMatchObject({ type: "workflow_run.escalated" });
  expect(next).toMatchObject({
    action: "escalate",
    escalation_reason: "execute_request",
  });
});

test("workflow effect receipts remain idempotent without watcher acknowledgement", () => {
  const { run } = createRun();
  S.emitEvent(repoId, "workflow_run.turn_done", "test", { id: run });
  runWatch(run);
  const eventId = JSON.parse(runWatch(run).stdout).event.id;
  const effectArgs = [
    "--repo",
    "me/workflow-watch",
    "--run",
    String(run),
    "--event",
    String(eventId),
    "--effect",
    "test.notification",
    "--json",
  ];
  const claimed = JSON.parse(
    runCli(["workflow", "effect", "begin", ...effectArgs]).stdout,
  );
  expect(claimed).toMatchObject({ execute: true, status: "pending" });

  // Model a stop after the external side effect but before its receipt is completed. Replay sees
  // the durable pending claim and must not authorize the non-idempotent effect a second time.
  const afterSideEffectStop = JSON.parse(
    runCli(["workflow", "effect", "begin", ...effectArgs]).stdout,
  );
  expect(afterSideEffectStop).toMatchObject({
    execute: false,
    ambiguous: true,
    status: "pending",
  });
  expect(runCli(["workflow", "effect", "complete", ...effectArgs]).status).toBe(
    0,
  );
});

test("a blocking watch completes when another process records an event", async () => {
  const { run } = createRun();
  runWatch(run);
  const waiting = startWatch(run);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const emitted = runCli([
    "workflow",
    "escalate",
    "--repo",
    "me/workflow-watch",
    "--run",
    String(run),
    "--reason",
    "Need human guidance",
  ]);
  expect(emitted.status).toBe(0);
  const result = await waiting;

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).event).toMatchObject({
    type: "workflow_run.escalated",
  });
});

test("a PR event recorded before the run started is not in its subscription", () => {
  const issue = S.createIssue(repoId, "issue", "bound", "", "me");
  const prIssue = S.createIssue(repoId, "pull", "bound pr", "", "me");
  S.createPull(
    prIssue.id,
    `loophub/pr-${prIssue.number}`,
    "main",
    null,
    issue.id,
  );
  // An earlier attempt's comment on the same PR, recorded before this run exists.
  S.emitEvent(repoId, "pull_request.commented", "me", {
    number: prIssue.number,
    comment_id: 4001,
    author_type: "human",
    source_payload_version: 1,
  });
  const run = S.createWorkflowRun({
    workflowId,
    repoId,
    issueNumber: issue.number,
    prNumber: prIssue.number,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 1,
    costLimitUsd: 1,
  }).id;
  S.emitEvent(repoId, "workflow_run.started", "me", {
    id: run,
    workflow_id: workflowId,
    issue_number: issue.number,
    pr_number: prIssue.number,
    session_id: null,
  });

  // The first wake is the run's own start, not the backlog its cursor never had to skip.
  expect(JSON.parse(runWatch(run).stdout).event).toMatchObject({
    type: "workflow_run.started",
  });
});

test("a run with no recorded start fails visibly and keeps its cursor", () => {
  const { run } = createRun({ started: false });
  S.emitEvent(repoId, "workflow_run.turn_done", "test", { id: run });

  const result = runWatch(run);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("has no workflow_run.started event");
  expect(runCursor(run)).toBe(0);
});

test("a human PR comment wakes the run from its source event alone", () => {
  const { run, pr } = createRun();
  runWatch(run);
  S.emitEvent(repoId, "pull_request.commented", "me", {
    number: pr,
    comment_id: 5001,
    author_type: "human",
    source_payload_version: 1,
  });

  const result = JSON.parse(runWatch(run).stdout);

  expect(result.event).toMatchObject({ type: "pull_request.commented" });
  expect(result.action).toBe("deliver");
});

// One deploy-boundary pair as the pre-cutover producers wrote it: an unmarked source, an
// unrelated event that happened to land between them, and the run-scoped twin that named the
// source. The reader has to take exactly one instruction from the pair and lose neither the
// unrelated event nor the ordering.
function emitLegacyPair(
  run: number,
  issue: number,
  pr: number,
  commentId: number,
) {
  const source = S.emitEvent(repoId, "pull_request.commented", "me", {
    number: pr,
    comment_id: commentId,
    author_type: "human",
  });
  const unrelated = S.emitEvent(repoId, "issue.labeled", "me", {
    number: issue,
    labels: ["needs-review"],
  });
  const twin = S.emitEvent(repoId, "workflow_run.pr_comment", "me", {
    id: run,
    number: pr,
    pr_number: pr,
    parent_session_id: null,
    source_event_id: source.id,
    source_event_type: "pull_request.commented",
    comment_id: commentId,
    author: "me",
    body: "Please rename this.",
  });
  return { source, unrelated, twin };
}

test("an old unmarked pair yields one instruction with the cursor before it", () => {
  const { run, issue, pr } = createRun();
  runWatch(run);
  const pair = emitLegacyPair(run, issue, pr, 6001);

  // The unmarked source predates the stable ids the reader would build an instruction from, so it
  // only wakes state observation.
  const atSource = JSON.parse(runWatch(run).stdout);
  expect(atSource.event.id).toBe(pair.source.id);
  expect(atSource.action).not.toBe("deliver");

  // The cursor moves one row at a time, so the event between the pair is not skipped over.
  expect(JSON.parse(runWatch(run).stdout).event.id).toBe(pair.unrelated.id);

  const atTwin = JSON.parse(runWatch(run).stdout);
  expect(atTwin.event.id).toBe(pair.twin.id);
  expect(atTwin).toMatchObject({
    action: "deliver",
    delivery_reason: "pr_comment",
    comment_id: 6001,
  });
});

test("an old unmarked pair yields one instruction with the cursor between it", () => {
  const { run, issue, pr } = createRun();
  runWatch(run);
  const pair = emitLegacyPair(run, issue, pr, 6002);
  S.advanceWorkflowRunEventCursor(run, pair.source.id);

  expect(JSON.parse(runWatch(run).stdout).event.id).toBe(pair.unrelated.id);
  expect(JSON.parse(runWatch(run).stdout)).toMatchObject({
    action: "deliver",
    delivery_reason: "pr_comment",
    comment_id: 6002,
  });
});

test("an old unmarked pair yields no instruction with the cursor after it", () => {
  const { run, issue, pr } = createRun();
  runWatch(run);
  const pair = emitLegacyPair(run, issue, pr, 6003);
  S.advanceWorkflowRunEventCursor(run, pair.twin.id);
  const wake = S.emitEvent(repoId, "workflow_run.updated", "me", { id: run });

  const result = JSON.parse(runWatch(run).stdout);
  expect(result.event.id).toBe(wake.id);
  expect(result.action).not.toBe("deliver");
});

test("a marked source instructs once even when a legacy twin arrives after it", () => {
  const { run, pr } = createRun();
  runWatch(run);
  // A rolling deploy: the new producer wrote a marked source, an old process still wrote the twin.
  const source = S.emitEvent(repoId, "pull_request.commented", "me", {
    number: pr,
    comment_id: 6004,
    author_type: "human",
    source_payload_version: 1,
  });
  S.emitEvent(repoId, "workflow_run.pr_comment", "me", {
    id: run,
    number: pr,
    pr_number: pr,
    parent_session_id: null,
    source_event_id: source.id,
    source_event_type: "pull_request.commented",
    comment_id: 6004,
    author: "me",
    body: "Please rename this.",
  });

  expect(JSON.parse(runWatch(run).stdout)).toMatchObject({
    action: "deliver",
    delivery_reason: "pr_comment",
    comment_id: 6004,
  });
  // The twin names a marked source, so it advances the cursor without repeating the instruction.
  expect(JSON.parse(runWatch(run).stdout).action).not.toBe("deliver");
});

test("a source wake claims no lifecycle effect receipt", () => {
  const { run, pr } = createRun();
  runWatch(run);
  S.emitEvent(repoId, "pull_request.commented", "me", {
    number: pr,
    comment_id: 6005,
    author_type: "human",
    source_payload_version: 1,
  });
  const wake = JSON.parse(runWatch(run).stdout).event;

  // Lifecycle receipts — cost hold, escalation — stay anchored to the run's own events. A source
  // event is not one of them, and the claim says so instead of widening with the subscription.
  const claim = runCli([
    "workflow",
    "effect",
    "begin",
    "--repo",
    "me/workflow-watch",
    "--run",
    String(run),
    "--event",
    String(wake.id),
    "--effect",
    "test.notification",
    "--json",
  ]);
  expect(claim.status).not.toBe(0);
  expect(claim.stderr).toContain("does not belong to run");
  expect(S.pendingWorkflowEventEffect(run)).toBeNull();
});

test.each([
  ["a missing run", ["workflow", "next", "--repo", "me/workflow-watch"]],
  [
    "an unknown run",
    ["workflow", "next", "999999", "--repo", "me/workflow-watch", "--watch"],
  ],
  [
    "watch combined with note",
    [
      "workflow",
      "next",
      "1",
      "--repo",
      "me/workflow-watch",
      "--watch",
      "--note",
      "do this",
    ],
  ],
])("lh workflow next rejects %s with a visible non-zero exit", (_name, args) => {
  const result = runCli(args);

  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toBe("");
});
