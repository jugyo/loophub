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
function createRun(): number {
  const issue = S.createIssue(repoId, "issue", "watch", "", "me");
  const prIssue = S.createIssue(repoId, "pull", "watch pr", "", "me");
  S.createPull(
    prIssue.id,
    `loophub/pr-${prIssue.number}`,
    "main",
    null,
    issue.id,
  );
  return S.createWorkflowRun({
    workflowId,
    repoId,
    issueNumber: issue.number,
    prNumber: prIssue.number,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 1,
    costLimitUsd: 1,
  }).id;
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
  const run = createRun();
  S.emitEvent(repoId, "workflow_run.turn_done", "test", { id: run });
  S.emitEvent(repoId, "workflow_run.escalated", "test", {
    id: run,
    reason: "Need human guidance",
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
  const run = createRun();
  S.emitEvent(repoId, "workflow_run.turn_done", "test", { id: run });
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
  const run = createRun();
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
