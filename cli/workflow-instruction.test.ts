import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-workflow-instruction-"));
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

// A run needs the Issue/PR rows the decision observes. The PR's worktree is never provisioned, so
// HEAD stays unresolved and the state-derived decision here is always the same — what these tests
// assert is the command's own contract, not the reconcile rules
// (core/workflow-runs-service.test.ts).
function createRun(): number {
  const issue = S.createIssue(repoId, "issue", "instruction", "", "me");
  const prIssue = S.createIssue(repoId, "pull", "instruction pr", "", "me");
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

beforeAll(async () => {
  S = await import("../core/store.ts");
  const repo = S.createRepo("me/workflow-instruction", process.cwd());
  repoId = repo.id;
  workflowId = S.createWorkflow({
    name: "instruction-test",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  }).id;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("lh workflow instruction --note decides from a direct human instruction", () => {
  const run = createRun();

  const result = runCli([
    "workflow",
    "instruction",
    String(run),
    "--repo",
    "me/workflow-instruction",
    "--note",
    "keep going",
    "--json",
  ]);

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const decided = JSON.parse(result.stdout);
  expect(decided).toMatchObject({
    action: "deliver",
    delivery_reason: "human_instruction",
  });
  expect(decided.observed.id).toBe(run);
  // A human instruction is not a run event, so the worker's delivery cursor is untouched.
  expect(decided.event).toBeNull();
  expect(S.getWorkflowRun(run)?.event_cursor).toBe(0);
});

test("workflow effect receipts stay idempotent across a replayed claim", () => {
  const run = createRun();
  const eventId = S.emitEvent(repoId, "workflow_run.turn_done", "test", {
    id: run,
  }).id;
  const effectArgs = [
    "--repo",
    "me/workflow-instruction",
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

test.each([
  ["a missing run", ["--note", "do this"]],
  ["an unknown run", ["999999", "--note", "do this"]],
  ["no parent input at all", ["1"]],
  ["an event without a verdict", ["1", "--event", "1"]],
  ["an event combined with a note", ["1", "--event", "1", "--note", "do this"]],
])("lh workflow instruction rejects %s with a visible non-zero exit", (_name, args) => {
  const result = runCli([
    "workflow",
    "instruction",
    ...args,
    "--repo",
    "me/workflow-instruction",
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toBe("");
});
