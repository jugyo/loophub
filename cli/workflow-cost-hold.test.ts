import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-workflow-cost-hold-"));
const bin = join(home, "bin");
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "loophub.db");

const NODE_ARGS = [
  "--experimental-sqlite",
  "--disable-warning=ExperimentalWarning",
  "--import",
  "tsx",
  "cli/index.ts",
];
const PARENT_SESSION_ID = "00000000-0000-4000-8000-000000000001";

let S: typeof import("../core/store.ts");
let repoId: number;
let workflowId: number;
let nextNumber = 1;

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      LOOPHUB_SESSION_ID: PARENT_SESSION_ID,
      ...extraEnv,
    },
    timeout: 20_000,
  });
}

function createCostEvent(options: { activeChild?: boolean } = {}): {
  run: number;
  event: number;
  log: string;
  reemit: (limitUsd?: number) => number;
} {
  const number = nextNumber++;
  const run = S.createWorkflowRun({
    workflowId,
    repoId,
    issueNumber: number,
    prNumber: number,
    status: "running",
    currentStep: "execute",
    parentSessionId: PARENT_SESSION_ID,
    costIncrementUsd: 10,
    costLimitUsd: 10,
  });
  const activeChild = options.activeChild !== false;
  const childSessionId = activeChild
    ? `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`
    : null;
  const agentName = `executor #${run.id}-1`;
  if (childSessionId) {
    S.registerAgentSession(
      childSessionId,
      "workflow-step",
      childSessionId,
      agentName,
      "codex",
      "workflow-step",
    );
    S.registerAgentExecutionTarget({
      sessionId: childSessionId,
      provider: "herdr",
      targetId: "w1:p2",
      context: "test-session",
    });
    S.appendWorkflowRunStepSession(run.id, "execute", childSessionId);
    S.updateWorkflowRun(run.id, {
      activeStep: "execute",
      activeSessionId: childSessionId,
    });
  }
  // A 0 ms re-emit interval stands in for "the interval has elapsed", so `reemit` deterministically
  // produces the further events a stopped parent leaves queued. `limitUsd` models the event a raised
  // limit produces once the run burns through it again.
  const emit = (limitUsd = 10): number => {
    const event = S.emitWorkflowRunCostExceeded(
      repoId,
      "test",
      {
        id: run.id,
        number,
        pr_number: number,
        parent_session_id: PARENT_SESSION_ID,
        session_id: PARENT_SESSION_ID,
        usage_session_id: PARENT_SESSION_ID,
        active_step: activeChild ? "execute" : null,
        active_session_id: childSessionId,
        cost_usd: limitUsd + 2.5,
        limit_usd: limitUsd,
        increment_usd: 10,
        next_limit_usd: limitUsd + 10,
      },
      0,
    );
    if (!event) throw new Error("cost event was not created");
    return event.id;
  };
  const event = emit();
  const log = join(home, `herdr-${run.id}.log`);
  writeFileSync(log, "");
  writeFileSync(
    join(home, `agents-${run.id}.json`),
    JSON.stringify({
      result: {
        agents: [
          {
            name: agentName,
            agent_status: "working",
            pane_id: "w1:p2",
          },
        ],
      },
    }),
  );
  return { run: run.id, event, log, reemit: emit };
}

function costHoldArgs(input: { run: number; event: number }): string[] {
  return [
    "workflow",
    "cost-hold",
    "--repo",
    "me/workflow-cost-hold",
    "--run",
    String(input.run),
    "--event",
    String(input.event),
  ];
}

beforeAll(async () => {
  S = await import("../core/store.ts");
  const repo = S.createRepo("me/workflow-cost-hold", process.cwd());
  repoId = repo.id;
  workflowId = S.createWorkflow({
    name: "cost-hold-test",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  }).id;
  S.registerAgentSession(
    PARENT_SESSION_ID,
    "workflow-parent",
    PARENT_SESSION_ID,
    "workflow parent",
    "codex",
    "workflow-parent",
  );

  mkdirSync(bin);
  const herdr = join(bin, "herdr");
  writeFileSync(
    herdr,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_LOG"
if [ "$HERDR_FAIL" = "send-keys" ] && printf '%s' "$*" | grep -q 'pane send-keys'; then
  exit 7
fi
if printf '%s' "$*" | grep -q 'agent list'; then
  cat "$HERDR_AGENTS"
fi
`,
  );
  chmodSync(herdr, 0o755);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("lh workflow cost-hold holds the run, sends Escape, and notifies the active pane", () => {
  const input = createCostEvent();
  const result = runCli(costHoldArgs(input), {
    HERDR_LOG: input.log,
    HERDR_AGENTS: join(home, `agents-${input.run}.json`),
  });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    `completed cost hold for event #${input.event}`,
  );
  expect(result.stdout).toContain("receipt\tcompleted");
  expect(S.getWorkflowRun(input.run)?.needs_human_reason).toBe(
    "Cost limit exceeded: current $12.5, limit $10; human decision required",
  );
  const log = readFileSync(input.log, "utf8");
  expect(log).not.toContain("agent list");
  expect(log).toContain("pane send-keys w1:p2 Escape");
  expect(log).toContain(
    "pane send-text w1:p2 \u001b[200~orchestrator: Cost limit exceeded: current $12.5, limit $10. Wait for human instruction.\u001b[201~",
  );
  expect(log).toContain("pane send-keys w1:p2 Enter");
});

test("a re-emitted cost event interrupts a run whose parent stopped before cost-hold (#1844)", () => {
  const input = createCostEvent();
  const env = {
    HERDR_LOG: input.log,
    HERDR_AGENTS: join(home, `agents-${input.run}.json`),
  };
  // The parent was handed the first event's instruction and stopped before running cost-hold. The
  // worker had already advanced its cursor past that event, so only a re-emission can interrupt the
  // run.
  const reemitted = input.reemit();
  expect(reemitted).not.toBe(input.event);

  const result = runCli(
    costHoldArgs({ run: input.run, event: reemitted }),
    env,
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    `completed cost hold for event #${reemitted}`,
  );
  expect(S.getWorkflowRun(input.run)?.needs_human_reason).toBe(
    "Cost limit exceeded: current $12.5, limit $10; human decision required",
  );
  const log = readFileSync(input.log, "utf8");
  expect(log).toContain("pane send-keys w1:p2 Escape");
});

test("queued re-emissions the parent drains after a hold do not replay the interrupt (#1844)", () => {
  const input = createCostEvent();
  const env = {
    HERDR_LOG: input.log,
    HERDR_AGENTS: join(home, `agents-${input.run}.json`),
  };
  // Detection kept re-emitting while the parent was away, so these stay queued after the worker's
  // cursor and are delivered to the parent one at a time.
  const queued = [input.reemit(), input.reemit()];
  expect(runCli(costHoldArgs(input), env).status).toBe(0);
  const heldLog = readFileSync(input.log, "utf8");
  const heldReason = S.getWorkflowRun(input.run)?.needs_human_reason;
  expect(heldReason).not.toBeNull();

  // The human said "no", so the hold stands. Draining the leftovers must not send Esc again, and
  // must not leave a pending receipt behind — that would pin the parent's reconcile to `wait`.
  for (const event of queued) {
    const drained = runCli(costHoldArgs({ run: input.run, event }), env);
    expect(drained.status, drained.stderr).toBe(0);
    expect(drained.stdout).toContain("receipt\tcompleted");
    expect(readFileSync(input.log, "utf8")).toBe(heldLog);
    expect(S.getWorkflowEventEffect(input.run, event, "cost.hold")).toBeNull();
  }
  expect(S.getWorkflowRun(input.run)?.needs_human_reason).toBe(heldReason);
});

test("a raised limit still holds again while the old limit's leftovers stay inert (#1844)", () => {
  const input = createCostEvent();
  const env = {
    HERDR_LOG: input.log,
    HERDR_AGENTS: join(home, `agents-${input.run}.json`),
  };
  const stale = input.reemit();
  expect(runCli(costHoldArgs(input), env).status).toBe(0);

  const increased = runCli([
    "workflow",
    "run",
    "increase-cost-limit",
    "--repo",
    "me/workflow-cost-hold",
    "--run",
    String(input.run),
    "--expected-limit",
    "10",
  ]);
  expect(increased.status, increased.stderr).toBe(0);
  const resumed = runCli([
    "workflow",
    "run",
    "resume",
    "--repo",
    "me/workflow-cost-hold",
    "--run",
    String(input.run),
    "--step",
    "execute",
  ]);
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(S.getWorkflowRun(input.run)?.needs_human_reason).toBeNull();
  const resumedLog = readFileSync(input.log, "utf8");

  // A leftover event names the old limit the human already answered for; re-holding here would
  // interrupt a child that is running under the raised limit.
  const drained = runCli(costHoldArgs({ run: input.run, event: stale }), env);
  expect(drained.status, drained.stderr).toBe(0);
  expect(drained.stdout).toContain("receipt\tcompleted");
  expect(readFileSync(input.log, "utf8")).toBe(resumedLog);
  expect(S.getWorkflowRun(input.run)?.needs_human_reason).toBeNull();

  // Burning through the raised limit is a new interrupt, not a replay.
  const raised = input.reemit(20);
  const held = runCli(costHoldArgs({ run: input.run, event: raised }), env);
  expect(held.status, held.stderr).toBe(0);
  expect(held.stdout).toContain(`completed cost hold for event #${raised}`);
  expect(S.getWorkflowRun(input.run)?.needs_human_reason).toBe(
    "Cost limit exceeded: current $22.5, limit $20; human decision required",
  );
  expect(readFileSync(input.log, "utf8")).not.toBe(resumedLog);
});

test("lh workflow cost-hold does not fire effects twice for the same event", () => {
  const input = createCostEvent();
  const env = {
    HERDR_LOG: input.log,
    HERDR_AGENTS: join(home, `agents-${input.run}.json`),
  };
  expect(runCli(costHoldArgs(input), env).status).toBe(0);
  const firstLog = readFileSync(input.log, "utf8");
  S.updateWorkflowRun(input.run, { status: "completed" });

  const replay = runCli(costHoldArgs(input), env);

  expect(replay.status, replay.stderr).toBe(0);
  expect(replay.stdout).toContain(
    `cost hold for event #${input.event} is already complete`,
  );
  expect(replay.stdout).toContain("receipt\tcompleted");
  expect(readFileSync(input.log, "utf8")).toBe(firstLog);
});

test("a partial cost-hold failure is visible and leaves the run held", () => {
  const input = createCostEvent();
  const env = {
    HERDR_LOG: input.log,
    HERDR_AGENTS: join(home, `agents-${input.run}.json`),
    HERDR_FAIL: "send-keys",
  };
  const failed = runCli(costHoldArgs(input), env);

  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("cost hold failed at Escape");
  expect(failed.stderr).toContain("completed: await-human");
  expect(S.getWorkflowRun(input.run)?.needs_human_reason).not.toBeNull();
  expect(readFileSync(input.log, "utf8")).not.toContain("pane send-text");

  const logAfterFailure = readFileSync(input.log, "utf8");
  const replay = runCli(costHoldArgs(input), {
    ...env,
    HERDR_FAIL: "",
  });
  expect(replay.status).not.toBe(0);
  expect(replay.stderr).toContain(
    `cost hold for event #${input.event} is pending`,
  );
  expect(readFileSync(input.log, "utf8")).toBe(logAfterFailure);
});

test("a missing active child is visible and still establishes the hold", () => {
  const input = createCostEvent({ activeChild: false });
  const result = runCli(costHoldArgs(input), {
    HERDR_LOG: input.log,
    HERDR_AGENTS: join(home, `agents-${input.run}.json`),
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("cost hold failed at target resolution");
  expect(result.stderr).toContain("completed: await-human");
  expect(S.getWorkflowRun(input.run)?.needs_human_reason).not.toBeNull();
});

test("an unrelated existing human hold is not reported as a completed cost hold", () => {
  const input = createCostEvent();
  S.updateWorkflowRun(input.run, {
    needsHumanReason: "Waiting for a product decision",
  });

  const result = runCli(costHoldArgs(input), {
    HERDR_LOG: input.log,
    HERDR_AGENTS: join(home, `agents-${input.run}.json`),
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("cost hold failed at await-human");
  expect(result.stderr).toContain("completed: none");
  expect(S.getWorkflowRun(input.run)?.needs_human_reason).toBe(
    "Waiting for a product decision",
  );
  expect(readFileSync(input.log, "utf8")).not.toContain("pane send-keys");
});

test("an existing cost hold remains a visible error instead of recovering automatically", () => {
  const input = createCostEvent();
  S.updateWorkflowRun(input.run, {
    needsHumanReason:
      "Cost limit exceeded: current $12.5, limit $10; human decision required",
  });

  const result = runCli(costHoldArgs(input), {
    HERDR_LOG: input.log,
    HERDR_AGENTS: join(home, `agents-${input.run}.json`),
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("cost hold failed at await-human");
  expect(result.stderr).toContain(
    "Workflow run is already waiting for a human",
  );
  expect(result.stderr).toContain("completed: none");
  expect(readFileSync(input.log, "utf8")).not.toContain("pane send-keys");
});
