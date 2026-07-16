import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { herdrSessionName } from "./terminal/terminal-launch.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-cost-stop-"));
const FAKE_BIN = mkdtempSync(join(tmpdir(), "lh-workflow-cost-stop-bin-"));
const SEND_LOG = join(HOME, "send.log");
const ORIGINAL_PATH = process.env.PATH;
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let D: typeof import("./db.ts");
let runSequence = 0;

beforeAll(async () => {
  writeFileSync(
    join(HOME, "config.json"),
    JSON.stringify({ devCostLimitUsd: 10 }),
  );
  svc = await import("./service.ts");
  S = await import("./store.ts");
  D = await import("./db.ts");
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(HOME, { recursive: true, force: true });
  rmSync(FAKE_BIN, { recursive: true, force: true });
});

function installHerdr(agents: unknown, failSend = false): void {
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `if [ "$4" = "list" ]; then printf '%s' '${JSON.stringify(agents)}'; exit 0; fi`,
      ...(failSend ? ["exit 1"] : []),
      `printf '%s\\n' "$*" >> '${SEND_LOG}'`,
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH}`;
}

function setupRun(step: "execute" | "verify") {
  runSequence++;
  const repoPath = mkdtempSync(join(tmpdir(), `workflow-cost-${step}-`));
  const repo = S.createRepo(
    `me/workflow-cost-${step}-${runSequence}`,
    repoPath,
  );
  const issue = S.createIssue(repo.id, "issue", "Issue", "", "me");
  const pr = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(pr.id, `loophub/pr-${pr.number}`, "main", null, issue.id);
  const workflow = S.createWorkflow({
    name: `cost-${step}-${runSequence}`,
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = `${step}-${runSequence}-parent`;
  const execute = `${step}-${runSequence}-execute`;
  const verify = `${step}-${runSequence}-verify`;
  S.registerAgentSession(parent, "lh-workflow", parent, `orchestrator #1`);
  S.registerAgentSession(execute, "workflow-step", execute);
  S.registerAgentSession(verify, "workflow-step", verify);
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: pr.number,
    status: "running",
    currentStep: step,
    parentSessionId: parent,
  });
  S.registerAgentSession(
    execute,
    "workflow-step",
    execute,
    `executor #${run.id}-1`,
  );
  S.registerAgentSession(
    verify,
    "workflow-step",
    verify,
    `verifier #${run.id}-2`,
  );
  S.appendWorkflowRunStepSession(run.id, "execute", execute);
  S.appendWorkflowRunStepSession(run.id, "verify", verify);
  S.upsertSessionUsage(parent, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 6,
  });
  S.upsertSessionUsage(execute, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 3,
  });
  S.upsertSessionUsage(verify, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 2,
  });
  return { repo, repoPath, pr, run, parent, execute, verify };
}

describe.each([
  "execute",
  "verify",
] as const)("Workflow %s cost stop", (step) => {
  test("stops only the latest running current-step child and records one event", async () => {
    const { repo, repoPath, pr, run, parent, execute, verify } = setupRun(step);
    const target = step === "execute" ? execute : verify;
    const other = step === "execute" ? verify : execute;
    const targetName = S.getAgentSession(target)!.name;
    const otherName = S.getAgentSession(other)!.name;
    installHerdr({
      result: {
        agents: [
          {
            name: `orchestrator #${run.id}`,
            agent_status: "working",
            pane_id: "w1:p1",
            foreground_cwd: repoPath,
          },
          {
            name: otherName,
            agent_status: "working",
            pane_id: "w1:p2",
            foreground_cwd: `${HOME}/worktrees/${repo.full_name}/pr-${pr.number}`,
          },
          {
            name: targetName,
            agent_status: "working",
            pane_id: "w1:p3",
            foreground_cwd: `${HOME}/worktrees/${repo.full_name}/pr-${pr.number}`,
          },
        ],
      },
    });

    const results = await Promise.all([
      svc.workflowRuns.enforceCostLimit(
        repo.full_name,
        { run: run.id, usageSession: target },
        parent,
      ),
      svc.workflowRuns.enforceCostLimit(
        repo.full_name,
        { run: run.id, usageSession: target },
        parent,
      ),
    ]);
    const result = results.find((item) => item.action === "stopped");

    expect(result).toMatchObject({
      action: "stopped",
      reason: "over_limit",
      cost_usd: 11,
      limit_usd: 10,
      stopped_session_id: target,
      run: { status: "stopped" },
    });
    expect(
      S.listEvents(0, repo.id, 100).filter(
        (event) => event.type === "dev.cost_stopped",
      ),
    ).toHaveLength(1);
    expect(
      JSON.parse(
        S.listEvents(0, repo.id, 100).find(
          (event) => event.type === "dev.cost_stopped",
        )!.payload,
      ),
    ).toMatchObject({
      run_id: run.id,
      pr: pr.number,
      session_id: target,
      step,
      cost_usd: 11,
      limit_usd: 10,
    });
    const log = await import("node:fs").then(({ readFileSync }) =>
      readFileSync(SEND_LOG, "utf8"),
    );
    expect(log).toContain(
      `--session ${herdrSessionName(repo)} pane send-keys w1:p3 Escape`,
    );
    expect(log).not.toContain("w1:p2 Escape");
    const second = results.find((item) => item.action === "skipped");
    expect(second).toMatchObject({
      action: "skipped",
      reason: "already_stopped",
      cost_usd: 11,
    });
    expect(
      S.listEvents(0, repo.id, 100).filter(
        (event) => event.type === "dev.cost_stopped",
      ),
    ).toHaveLength(1);
  });
});

test("stops a continuing Execute child while run.current_step remains verify", async () => {
  const { repo, pr, run, parent, execute, verify } = setupRun("verify");
  installHerdr({
    result: {
      agents: [
        {
          name: S.getAgentSession(verify)!.name,
          agent_status: "working",
          pane_id: "w2:p2",
          foreground_cwd: `${HOME}/worktrees/${repo.full_name}/pr-${pr.number}`,
        },
        {
          name: S.getAgentSession(execute)!.name,
          agent_status: "working",
          pane_id: "w2:p3",
          foreground_cwd: `${HOME}/worktrees/${repo.full_name}/pr-${pr.number}`,
        },
      ],
    },
  });

  const result = await svc.workflowRuns.enforceCostLimit(
    repo.full_name,
    { run: run.id, usageSession: execute },
    parent,
  );

  expect(result).toMatchObject({
    action: "stopped",
    stopped_session_id: execute,
  });
  const event = S.listEvents(0, repo.id, 100).find(
    (item) => item.type === "dev.cost_stopped",
  );
  expect(JSON.parse(event!.payload)).toMatchObject({
    session_id: execute,
    step: "execute",
  });
});

test("parent usage stops only the current Verify child when an older Execute is also working", async () => {
  const { repo, pr, run, parent, execute, verify } = setupRun("verify");
  // Make the past Execute usage newer than Verify usage. Parent-originated selection must still
  // follow current_step rather than choosing the most recently updated session across all steps.
  S.upsertSessionUsage(execute, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 3,
  });
  installHerdr({
    result: {
      agents: [
        {
          name: S.getAgentSession(execute)!.name,
          agent_status: "working",
          pane_id: "w5:p2",
          foreground_cwd: `${HOME}/worktrees/${repo.full_name}/pr-${pr.number}`,
        },
        {
          name: S.getAgentSession(verify)!.name,
          agent_status: "working",
          pane_id: "w5:p3",
          foreground_cwd: `${HOME}/worktrees/${repo.full_name}/pr-${pr.number}`,
        },
      ],
    },
  });

  const result = await svc.workflowRuns.enforceCostLimit(
    repo.full_name,
    { run: run.id, usageSession: parent },
    parent,
  );

  expect(result).toMatchObject({
    action: "stopped",
    stopped_session_id: verify,
  });
  const event = S.listEvents(0, repo.id, 100).find(
    (item) => item.type === "dev.cost_stopped",
  );
  expect(JSON.parse(event!.payload)).toMatchObject({
    session_id: verify,
    step: "verify",
  });
});

test("stops from recorded costs when another run session has no usage yet", async () => {
  const { repo, pr, run, parent, execute, verify } = setupRun("execute");
  S.resetSessionUsage(verify);
  S.upsertSessionUsage(parent, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 18,
  });
  S.appendWorkflowRunStepSession(run.id, "execute", parent);
  installHerdr({
    result: {
      agents: [
        {
          name: S.getAgentSession(execute)!.name,
          agent_status: "working",
          pane_id: "w6:p2",
          foreground_cwd: `${HOME}/worktrees/${repo.full_name}/pr-${pr.number}`,
        },
      ],
    },
  });

  const result = await svc.workflowRuns.enforceCostLimit(
    repo.full_name,
    { run: run.id, usageSession: execute },
    parent,
  );

  expect(result).toMatchObject({
    action: "stopped",
    reason: "over_limit",
    cost_usd: 21,
    unobserved_session_ids: [verify],
    unknown_cost_session_ids: [],
    run: { status: "stopped" },
  });
});

test("does not stop and identifies a session with explicitly unknown cost", async () => {
  const { repo, run, parent, verify } = setupRun("execute");
  D.db.run(`UPDATE session_usage SET cost_usd = NULL WHERE session_id = ?`, [
    verify,
  ]);

  const result = await svc.workflowRuns.enforceCostLimit(
    repo.full_name,
    { run: run.id, usageSession: verify },
    parent,
  );

  expect(result).toMatchObject({
    action: "skipped",
    reason: "unknown_cost",
    cost_usd: null,
    unobserved_session_ids: [],
    unknown_cost_session_ids: [verify],
    run: { status: "running" },
  });
  expect(
    S.listEvents(0, repo.id, 100).some(
      (event) => event.type === "dev.cost_stopped",
    ),
  ).toBe(false);
});

test("rejects a usage session from another run without stopping this run", async () => {
  const { repo, run, parent } = setupRun("execute");

  await expect(
    svc.workflowRuns.enforceCostLimit(
      repo.full_name,
      { run: run.id, usageSession: "another-run-session" },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(S.getWorkflowRun(run.id)?.status).toBe("running");
  expect(
    S.listEvents(0, repo.id, 100).some(
      (event) => event.type === "dev.cost_stopped",
    ),
  ).toBe(false);
});

test("does not stop a historical child whose only pane is waiting at repo root", async () => {
  const { repo, repoPath, run, parent, execute } = setupRun("execute");
  const currentExecute = `current-execute-${run.id}`;
  S.registerAgentSession(
    currentExecute,
    "workflow-step",
    currentExecute,
    `executor #${run.id}-3`,
  );
  S.appendWorkflowRunStepSession(run.id, "execute", currentExecute);
  S.upsertSessionUsage(currentExecute, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 1,
  });
  installHerdr({
    result: {
      agents: [
        {
          name: S.getAgentSession(execute)!.name,
          agent_status: "idle",
          pane_id: "w3:p3",
          foreground_cwd: repoPath,
        },
      ],
    },
  });

  await expect(
    svc.workflowRuns.enforceCostLimit(
      repo.full_name,
      { run: run.id, usageSession: execute },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(S.getWorkflowRun(run.id)?.status).toBe("running");
});

test("records a visible failure and never reports a successful stop event when Escape fails", async () => {
  const { repo, pr, run, parent, execute } = setupRun("execute");
  installHerdr(
    {
      result: {
        agents: [
          {
            name: S.getAgentSession(execute)!.name,
            agent_status: "working",
            pane_id: "w4:p4",
            foreground_cwd: `${HOME}/worktrees/${repo.full_name}/pr-${pr.number}`,
          },
        ],
      },
    },
    true,
  );

  await expect(
    svc.workflowRuns.enforceCostLimit(
      repo.full_name,
      { run: run.id, usageSession: execute },
      parent,
    ),
  ).rejects.toMatchObject({ status: 500 });
  expect(S.getWorkflowRun(run.id)?.status).toBe("stopped");
  expect(S.listEvents(0, repo.id, 100).map((event) => event.type)).toContain(
    "workflow_run.cost_stop_failed",
  );
  expect(
    S.listEvents(0, repo.id, 100).map((event) => event.type),
  ).not.toContain("dev.cost_stopped");
});
