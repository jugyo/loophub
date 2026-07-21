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
let nextNumber = 1;

function runCli(args: string[]) {
  return spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    timeout: 3_000,
  });
}

function watchArgs(run: number, extra: string[] = []) {
  return [
    "--repo",
    "me/workflow-watch",
    "--run",
    String(run),
    "--json",
    ...extra,
  ];
}

function runWatch(run: number, extra: string[] = []) {
  return runCli(["workflow", "watch", ...watchArgs(run, extra)]);
}

function createRun(): number {
  const number = nextNumber++;
  return S.createWorkflowRun({
    workflowId,
    repoId,
    issueNumber: number,
    prNumber: number,
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
  const child = spawn(
    process.execPath,
    [...NODE_ARGS, "workflow", "watch", ...watchArgs(run)],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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

test("lh workflow watch returns JSON and replays until its event cursor is acknowledged", () => {
  const run = createRun();
  S.emitEvent(repoId, "workflow_run.turn_done", "test", { id: run });
  S.emitEvent(repoId, "workflow_run.escalated", "test", { id: run });

  const first = runWatch(run);
  const replay = runWatch(run);
  const firstResult = JSON.parse(first.stdout);

  expect(first.error).toBeUndefined();
  expect(first.status).toBe(0);
  expect(firstResult.events).toEqual([
    expect.objectContaining({ type: "workflow_run.turn_done" }),
  ]);
  expect(JSON.parse(replay.stdout)).toEqual(firstResult);

  const skipped = runWatch(run, [
    "--ack",
    String(firstResult.cursor.delivered + 1),
  ]);
  expect(skipped.status).not.toBe(0);
  expect(skipped.stderr).toContain("cannot acknowledge cursor");

  const eventId = firstResult.events[0].id;
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
  const ackWhilePending = runWatch(run, [
    "--ack",
    String(firstResult.cursor.delivered),
  ]);
  expect(ackWhilePending.status).not.toBe(0);
  expect(ackWhilePending.stderr).toContain("could not be acknowledged");
  expect(runCli(["workflow", "effect", "complete", ...effectArgs]).status).toBe(
    0,
  );

  const afterEventCheckpoint = JSON.parse(
    runWatch(run, ["--ack", String(firstResult.cursor.delivered)]).stdout,
  );
  const replayAfterStop = JSON.parse(runWatch(run).stdout);
  expect(afterEventCheckpoint.events).toEqual([
    expect.objectContaining({ type: "workflow_run.escalated" }),
  ]);
  expect(replayAfterStop).toEqual(afterEventCheckpoint);
  expect(replayAfterStop.events).not.toContainEqual(
    expect.objectContaining({ type: "workflow_run.turn_done" }),
  );
});

test("a blocking watch completes when another process records an event", async () => {
  const run = createRun();
  const waiting = startWatch(run);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const emitted = runCli([
    "workflow",
    "turn",
    "done",
    "--repo",
    "me/workflow-watch",
    "--run",
    String(run),
  ]);
  expect(emitted.status).toBe(0);
  const result = await waiting;

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).events).toEqual([
    expect.objectContaining({ type: "workflow_run.turn_done" }),
  ]);
});

test.each([
  ["missing options", []],
  [
    "duplicate option",
    ["--repo", "me/workflow-watch", "--run", "999", "--run", "2"],
  ],
  [
    "unknown option",
    ["--repo", "me/workflow-watch", "--run", "999", "--runtime", "codex"],
  ],
  ["invalid run", ["--repo", "me/workflow-watch", "--run", "0"]],
])("lh workflow watch rejects %s with a visible non-zero exit", (_name, args) => {
  const result = runCli(["workflow", "watch", ...args]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("workflow watch:");
});
