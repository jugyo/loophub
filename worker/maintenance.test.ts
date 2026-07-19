import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { git, revParse } from "../core/git.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-worker-maintenance-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let M: typeof import("./maintenance.ts");
let svc: typeof import("../core/service.ts");
let S: typeof import("../core/store.ts");

beforeAll(async () => {
  M = await import("./maintenance.ts");
  svc = await import("../core/service.ts");
  S = await import("../core/store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function assistantLine(
  id: string,
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
  },
): string {
  return `${JSON.stringify({
    type: "assistant",
    message: {
      id,
      model: "claude-sonnet-4-6-20260601",
      usage,
    },
  })}\n`;
}

test("maintenance loop options keep 0 as disabled and default invalid values", () => {
  expect(
    M.normalizeMaintenanceLoopOptions({
      sweepMs: 0,
      usageSweepMs: Number.NaN,
      githubMergeSweepMs: 0,
      githubFeedbackSweepMs: 0,
      closedPullCleanupSweepMs: Number.NaN,
      scheduledTaskSweepMs: Number.NaN,
      conflictSweepMs: Number.NaN,
      herdrSweepMs: Number.NaN,
    }),
  ).toEqual({
    sweepMs: 0,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    githubMergeSweepMs: 0,
    githubFeedbackSweepMs: 0,
    closedPullCleanupSweepMs: M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    scheduledTaskSweepMs: M.DEFAULT_SCHEDULED_TASK_SWEEP_MS,
    conflictSweepMs: M.DEFAULT_CONFLICT_SWEEP_MS,
    herdrSweepMs: M.DEFAULT_HERDR_SWEEP_MS,
  });

  expect(M.normalizeMaintenanceLoopOptions()).toEqual({
    sweepMs: M.DEFAULT_SWEEP_MS,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    githubMergeSweepMs: M.DEFAULT_GITHUB_MERGE_SWEEP_MS,
    githubFeedbackSweepMs: M.DEFAULT_GITHUB_FEEDBACK_SWEEP_MS,
    closedPullCleanupSweepMs: M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    scheduledTaskSweepMs: M.DEFAULT_SCHEDULED_TASK_SWEEP_MS,
    conflictSweepMs: M.DEFAULT_CONFLICT_SWEEP_MS,
    herdrSweepMs: M.DEFAULT_HERDR_SWEEP_MS,
  });
});

test("closed PR cleanup defaults to a coarse interval", () => {
  expect(M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS).toBe(600000);
});

test("maintenance summary reports disabled loops as off", () => {
  expect(
    M.maintenanceSummary({
      sweepMs: 0,
      usageSweepMs: 25,
      githubMergeSweepMs: 0,
      githubFeedbackSweepMs: 30,
      closedPullCleanupSweepMs: 600000,
      scheduledTaskSweepMs: 0,
      conflictSweepMs: 0,
      herdrSweepMs: 0,
    }),
  ).toEqual({
    pullSweep: "off",
    usageSweep: "25ms",
    githubMergeSweep: "off",
    githubFeedbackSweep: "30ms",
    closedPullCleanupSweep: "600000ms",
    scheduledTaskSweep: "off",
    conflictSweep: "off",
    herdrSweep: "off",
  });
});

test("GitHub feedback sweep runs at its configured interval and logs per-PR failures", async () => {
  vi.useFakeTimers();
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const sweep = vi.fn(async () => ({
    checked: 2,
    emitted: [],
    failures: [
      { number: 7, github_number: 70, error: "auth failed\nnext line" },
    ],
  }));
  const stop = M.startGithubFeedbackSweep(25, sweep);
  try {
    await vi.advanceTimersByTimeAsync(24);
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining(
        "github feedback sweep PR failed pr=7 github_pr=70 error=auth failed next line",
      ),
    );
    expect(out).toHaveBeenCalledWith(
      expect.stringContaining(
        "github feedback sweep completed duration_ms=0 checked=2 emitted_events=0 failures=1",
      ),
    );
  } finally {
    stop();
    out.mockRestore();
    err.mockRestore();
    vi.useRealTimers();
  }
});

test("pull sweep logs start and completion to stdout", async () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const stop = M.startPullSweep(10);
  try {
    await waitUntil(
      () =>
        out.mock.calls.some(([message]) =>
          String(message).includes("lh-worker: pull sweep started"),
        ),
      "pull sweep start log",
    );
    await waitUntil(
      () =>
        out.mock.calls.some(
          ([message]) =>
            String(message).includes(
              "lh-worker: pull sweep completed duration_ms=",
            ) &&
            String(message).includes("emitted_events=0") &&
            String(message).includes("created_notifications=0"),
        ),
      "pull sweep completion log",
    );
  } finally {
    stop();
    out.mockRestore();
  }
});

test("closed pull cleanup sweep kills closed-PR agents", async () => {
  vi.useFakeTimers();
  const cleanupSpy = vi
    .spyOn(svc.terminal, "cleanupClosedPullDevAgents")
    .mockResolvedValue({ killed: 1, skipped: 0, failed: 0 });
  const stop = M.startClosedPullCleanupSweep(10);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    cleanupSpy.mockRestore();
    vi.useRealTimers();
  }
});

test("herdr snapshot sweep persists the snapshot every tick", async () => {
  vi.useFakeTimers();
  const snapshotSpy = vi
    .spyOn(svc.terminal, "snapshotHerdrSessions")
    .mockResolvedValue({
      repos: 1,
      running_repos: 1,
      changed: true,
      captured_at: "2026-07-19T00:00:00.000Z",
    });
  const stop = M.startHerdrSnapshotSweep(10);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(snapshotSpy).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    snapshotSpy.mockRestore();
    vi.useRealTimers();
  }
});

test("pull sweep fires pull_request.updated on head SHA change and no-ops when unchanged", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "lh-sweep-"));
  await git(repoPath, ["init", "-q", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "t@t.local"]);
  await git(repoPath, ["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "f.txt"), "base\n");
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-qm", "base"]);
  await git(repoPath, ["checkout", "-q", "-b", "loophub/issue-x"]);
  writeFileSync(join(repoPath, "f.txt"), "c1\n");
  await git(repoPath, ["commit", "-qam", "c1"]);

  const repo = S.createRepo("me/sweep", repoPath);
  const pull = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(pull.id, "loophub/issue-x", "main", null);
  const countUpdates = () =>
    S.listEvents(0, repo.id, 100).filter(
      (event) => event.type === "pull_request.updated",
    ).length;

  const stop = M.startPullSweep(20);
  try {
    const initialHead = await revParse(repoPath, "loophub/issue-x");
    await waitUntil(
      () => S.getPull(pull.id)!.head_sha === initialHead,
      "pull sweep baseline head",
    );
    expect(countUpdates()).toBe(0);

    writeFileSync(join(repoPath, "f.txt"), "c2\n");
    await git(repoPath, ["commit", "-qam", "c2"]);
    const updatedHead = await revParse(repoPath, "loophub/issue-x");
    await waitUntil(
      () =>
        S.getPull(pull.id)!.head_sha === updatedHead && countUpdates() === 1,
      "pull sweep updated head",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(countUpdates()).toBe(1);
  } finally {
    stop();
  }

  writeFileSync(join(repoPath, "f.txt"), "c3\n");
  await git(repoPath, ["commit", "-qam", "c3"]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(countUpdates()).toBe(1);
  rmSync(repoPath, { recursive: true, force: true });
});

test("usage sweep syncs changed usage and emits linked target events only on updates", async () => {
  const originalHome = process.env.HOME;
  process.env.HOME = HOME;
  const sessionId = "99999999-0000-0000-0000-000000000724";
  const parentSessionId = "99999999-0000-0000-0000-000000000725";
  S.registerAgentSession(
    sessionId,
    "workflow-step",
    sessionId,
    "executor #1-1",
    "claude-code",
    "workflow-step",
  );
  S.registerAgentSession(parentSessionId, "lh-workflow", parentSessionId);
  const repo = S.createRepo("me/usage-sweep", "/tmp/lh-usage-sweep-repo");
  const pull = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(pull.id, "loophub/issue-724", "main", null);
  S.linkSession(sessionId, pull.id);
  const workflow = S.createWorkflow({
    name: "usage-sweep-workflow",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 724,
    prNumber: pull.number,
    status: "running",
    currentStep: "execute",
    parentSessionId,
  });
  S.appendWorkflowRunStepSession(run.id, "execute", sessionId);
  S.upsertSessionUsage(parentSessionId, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 11,
  });
  const otherSessionId = "99999999-0000-0000-0000-000000000726";
  const otherParentSessionId = "99999999-0000-0000-0000-000000000727";
  S.registerAgentSession(otherSessionId, "workflow-step", otherSessionId);
  S.registerAgentSession(
    otherParentSessionId,
    "lh-workflow",
    otherParentSessionId,
  );
  const otherPull = S.createIssue(repo.id, "pull", "Other PR", "", "me");
  S.createPull(otherPull.id, "loophub/issue-725", "main", null);
  S.linkSession(otherSessionId, otherPull.id);
  const otherRun = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 725,
    prNumber: otherPull.number,
    status: "running",
    currentStep: "execute",
    parentSessionId: otherParentSessionId,
  });
  S.appendWorkflowRunStepSession(otherRun.id, "execute", otherSessionId);
  expect(
    svc.sessions.workflowUsageTarget(repo.id, pull.number, otherSessionId),
  ).toBeNull();
  expect(
    svc.sessions.workflowUsageTarget(repo.id, otherPull.number, sessionId),
  ).toBeNull();
  expect(
    svc.sessions.workflowUsageTarget(repo.id, otherPull.number, otherSessionId),
  ).toEqual({
    runId: otherRun.id,
    parentSessionId: otherParentSessionId,
  });

  const projectDir = join(HOME, ".claude", "projects", "repo-worktree");
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(
    transcript,
    assistantLine("msg_1", {
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 300,
      output_tokens: 10,
    }),
  );
  const usageEvents = () =>
    S.listEvents(0, repo.id, 100).filter(
      (event) => event.type === "agent_session.usage_updated",
    );
  const costExceededEvents = () =>
    S.listEvents(0, repo.id, 100).filter(
      (event) => event.type === "workflow_run.cost_exceeded",
    );

  const stop = M.startUsageSweep(20);
  try {
    await waitUntil(() => usageEvents().length === 1, "first usage event");
    expect(S.listSessionUsage(sessionId)[0]).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
    });
    expect(JSON.parse(usageEvents()[0].payload)).toMatchObject({
      session_id: sessionId,
      messages: 1,
      pr: pull.number,
    });
    expect(costExceededEvents()).toHaveLength(1);
    const costExceededPayload = JSON.parse(costExceededEvents()[0].payload);
    expect(costExceededPayload).toMatchObject({
      id: run.id,
      parent_session_id: parentSessionId,
      session_id: sessionId,
      pr_number: pull.number,
      limit_usd: 10,
    });
    expect(costExceededPayload.cost_usd).toBeGreaterThan(11);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(usageEvents()).toHaveLength(1);
    expect(costExceededEvents()).toHaveLength(1);
    appendFileSync(
      transcript,
      assistantLine("msg_2", {
        input_tokens: 7,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 3,
      }),
    );
    await waitUntil(() => usageEvents().length === 2, "second usage event");
    expect(costExceededEvents()).toHaveLength(1);
    expect(S.listSessionUsage(sessionId)[0]).toMatchObject({
      input_tokens: 107,
      output_tokens: 13,
    });
  } finally {
    stop();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
