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

function watchArgs(run: number, since = 0, extra: string[] = []) {
  return [
    "--repo",
    "me/workflow-watch",
    "--run",
    String(run),
    "--since",
    String(since),
    "--json",
    ...extra,
  ];
}

function runWatch(run: number, since = 0, extra: string[] = []) {
  return runCli(["workflow", "watch", ...watchArgs(run, since, extra)]);
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

test("lh workflow watch returns the next event and the command for the following wait", () => {
  const run = createRun();
  S.emitEvent(repoId, "workflow_run.turn_done", "test", { id: run });
  S.emitEvent(repoId, "workflow_run.escalated", "test", { id: run });

  const first = runWatch(run);
  const firstResult = JSON.parse(first.stdout);

  expect(first.error).toBeUndefined();
  expect(first.status).toBe(0);
  expect(firstResult.events).toEqual([
    expect.objectContaining({ type: "workflow_run.turn_done" }),
  ]);
  expect(firstResult.next_command).toBe(
    `lh workflow watch --repo 'me/workflow-watch' --run ${run} --since ${firstResult.events[0].id} --json`,
  );
  const next = JSON.parse(runWatch(run, firstResult.events[0].id).stdout);
  expect(next.events).toEqual([
    expect.objectContaining({ type: "workflow_run.escalated" }),
  ]);
  expect(next.next_command).toContain(`--since ${next.events[0].id} --json`);
});

test("workflow effect receipts remain idempotent without watcher acknowledgement", () => {
  const run = createRun();
  S.emitEvent(repoId, "workflow_run.turn_done", "test", { id: run });
  const firstResult = JSON.parse(runWatch(run).stdout);
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

test("a restarted watcher resumes from its cursor and receives the next event", () => {
  const run = createRun();
  S.emitEvent(repoId, "workflow_run.turn_done", "test", { id: run });
  S.emitEvent(repoId, "workflow_run.review_submitted", "test", { id: run });

  const first = JSON.parse(runWatch(run).stdout);
  const restarted = JSON.parse(runWatch(run, first.events[0].id).stdout);

  expect(first.events).toHaveLength(1);
  expect(restarted.events).toEqual([
    expect.objectContaining({ type: "workflow_run.review_submitted" }),
  ]);
  expect(restarted.events[0].id).toBeGreaterThan(first.events[0].id);
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
  [
    "invalid since",
    ["--repo", "me/workflow-watch", "--run", "999", "--since", "-1"],
  ],
])("lh workflow watch rejects %s with a visible non-zero exit", (_name, args) => {
  const result = runCli(["workflow", "watch", ...args]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("workflow watch:");
});
