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
import { WORKER_HEARTBEAT_STALE_AFTER_MS } from "../core/worker-protocol.ts";

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
      conflictSweepMs: Number.NaN,
      herdrSweepMs: Number.NaN,
      worktreePruneSweepMs: Number.NaN,
      workerHeartbeatMs: 0,
    }),
  ).toEqual({
    sweepMs: 0,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    githubMergeSweepMs: 0,
    githubFeedbackSweepMs: 0,
    closedPullCleanupSweepMs: M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    conflictSweepMs: M.DEFAULT_CONFLICT_SWEEP_MS,
    herdrSweepMs: M.DEFAULT_HERDR_SWEEP_MS,
    worktreePruneSweepMs: M.DEFAULT_WORKTREE_PRUNE_SWEEP_MS,
    workerHeartbeatMs: 0,
  });

  expect(M.normalizeMaintenanceLoopOptions()).toEqual({
    sweepMs: M.DEFAULT_SWEEP_MS,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    githubMergeSweepMs: M.DEFAULT_GITHUB_MERGE_SWEEP_MS,
    githubFeedbackSweepMs: M.DEFAULT_GITHUB_FEEDBACK_SWEEP_MS,
    closedPullCleanupSweepMs: M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    conflictSweepMs: M.DEFAULT_CONFLICT_SWEEP_MS,
    herdrSweepMs: M.DEFAULT_HERDR_SWEEP_MS,
    worktreePruneSweepMs: M.DEFAULT_WORKTREE_PRUNE_SWEEP_MS,
    workerHeartbeatMs: M.DEFAULT_WORKER_HEARTBEAT_MS,
  });
});

test("closed PR cleanup defaults to a coarse interval", () => {
  expect(M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS).toBe(600000);
});

test("worktree prune defaults to a coarse interval below the 24h grace period", () => {
  expect(M.DEFAULT_WORKTREE_PRUNE_SWEEP_MS).toBe(1800000);
});

test("maintenance summary reports disabled loops as off", () => {
  expect(
    M.maintenanceSummary({
      sweepMs: 0,
      usageSweepMs: 25,
      githubMergeSweepMs: 0,
      githubFeedbackSweepMs: 30,
      closedPullCleanupSweepMs: 600000,
      conflictSweepMs: 0,
      herdrSweepMs: 0,
      worktreePruneSweepMs: 0,
      workerHeartbeatMs: 25,
    }),
  ).toEqual({
    pullSweep: "off",
    usageSweep: "25ms",
    githubMergeSweep: "off",
    githubFeedbackSweep: "30ms",
    closedPullCleanupSweep: "600000ms",
    conflictSweep: "off",
    herdrSweep: "off",
    worktreePruneSweep: "off",
    workerHeartbeat: "25ms",
  });
});

test("worker heartbeat refreshes while running and expires after stop", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
  const startedAt = "2026-08-01T23:59:59Z";
  const stop = M.startWorkerHeartbeat(5_000, startedAt);
  try {
    expect(S.getWorkerRuntime()).toMatchObject({
      protocol_version: 1,
      started_at: startedAt,
      heartbeat_at: "2026-08-02T00:00:00.000Z",
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(S.getWorkerRuntime()?.heartbeat_at).toBe("2026-08-02T00:00:05.000Z");
    expect(svc.workerRuntime.status().status).toBe("compatible");

    stop();
    const stoppedHeartbeat = S.getWorkerRuntime()?.heartbeat_at;
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_STALE_AFTER_MS);
    expect(S.getWorkerRuntime()?.heartbeat_at).toBe(stoppedHeartbeat);
    expect(
      svc.workerRuntime.status(
        Date.parse(stoppedHeartbeat ?? "") +
          WORKER_HEARTBEAT_STALE_AFTER_MS +
          1,
      ).status,
    ).toBe("stale");
  } finally {
    stop();
    vi.useRealTimers();
  }
});

test("worker heartbeat stays fresh while usage sync is still running", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
  let finishUsageSync!: (result: {
    synced: number;
    skipped: number;
    missing: number;
    sessions: [];
  }) => void;
  const usageSync = vi.fn(
    () =>
      new Promise<{
        synced: number;
        skipped: number;
        missing: number;
        sessions: [];
      }>((resolve) => {
        finishUsageSync = resolve;
      }),
  );
  const stopHeartbeat = M.startWorkerHeartbeat(
    5_000,
    "2026-08-02T00:00:00.000Z",
  );
  const stopUsage = M.startUsageSweep(1_000, usageSync);
  try {
    await vi.advanceTimersByTimeAsync(WORKER_HEARTBEAT_STALE_AFTER_MS + 1);
    expect(usageSync).toHaveBeenCalledTimes(1);
    expect(svc.workerRuntime.status().status).toBe("compatible");
  } finally {
    stopUsage();
    stopHeartbeat();
    finishUsageSync?.({ synced: 0, skipped: 0, missing: 0, sessions: [] });
    await Promise.resolve();
    vi.useRealTimers();
  }
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

test("GitHub merge sweep also refreshes PR status and isolates status failures", async () => {
  vi.useFakeTimers();
  const mergeSweep = vi.fn(async () => []);
  const statusSweep = vi.fn(async () => {
    throw new Error("gh auth failed");
  });
  const stop = M.startGithubMergeSweep(25, mergeSweep, statusSweep);
  try {
    await vi.advanceTimersByTimeAsync(25);
    expect(mergeSweep).toHaveBeenCalledTimes(1);
    expect(statusSweep).toHaveBeenCalledTimes(1);
  } finally {
    stop();
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

test("worktree prune sweep logs removals and per-worktree failures", async () => {
  vi.useFakeTimers();
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const prune = vi.fn(async () => ({
    scanned: 3,
    candidates: 2,
    removed: 1,
    failed: [
      {
        repo: "me/prune",
        path: "/tmp/wt-2",
        reason: "git worktree remove failed\nlocked",
      },
    ],
  }));
  const stop = M.startWorktreePruneSweep(25, prune);
  try {
    await vi.advanceTimersByTimeAsync(24);
    expect(prune).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining(
        "worktree prune sweep removal failed repo=me/prune path=/tmp/wt-2 error=git worktree remove failed locked",
      ),
    );
    expect(out).toHaveBeenCalledWith(
      expect.stringContaining(
        "worktree prune sweep completed duration_ms=0 scanned=3 candidates=2 removed=1 failures=1",
      ),
    );
  } finally {
    stop();
    out.mockRestore();
    err.mockRestore();
    vi.useRealTimers();
  }
});

test("worktree prune sweep failure is logged and the loop keeps ticking", async () => {
  vi.useFakeTimers();
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const prune = vi
    .fn()
    .mockRejectedValueOnce(new Error("git worktree list failed"))
    .mockResolvedValue({ scanned: 0, candidates: 0, removed: 0, failed: [] });
  const stop = M.startWorktreePruneSweep(10, prune);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining(
        "worktree prune sweep failed duration_ms=0 error=git worktree list failed",
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(prune).toHaveBeenCalledTimes(2);
    expect(out).toHaveBeenCalledWith(
      expect.stringContaining("worktree prune sweep completed"),
    );
  } finally {
    stop();
    out.mockRestore();
    err.mockRestore();
    vi.useRealTimers();
  }
});

// A prune outliving its own interval must not stall the rest of the worker: the git subprocesses
// are awaited, not blocking, so sibling loops keep completing — and the in-flight guard means the
// slow prune is never started a second time meanwhile.
test("a slow worktree prune blocks neither other sweeps nor its own next tick", async () => {
  vi.useFakeTimers();
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  let releasePrune: () => void = () => {};
  const prune = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<typeof svc.worktrees.autoPrune>>>(
        (resolve) => {
          releasePrune = () =>
            resolve({ scanned: 1, candidates: 1, removed: 1, failed: [] });
        },
      ),
  );
  const cleanupSpy = vi
    .spyOn(svc.terminal, "cleanupClosedPullDevAgents")
    .mockResolvedValue({ killed: 0, skipped: 0, failed: 0 });
  const stopPrune = M.startWorktreePruneSweep(10, prune);
  const stopCleanup = M.startClosedPullCleanupSweep(10);
  try {
    await vi.advanceTimersByTimeAsync(35);
    // The prune is still running; the sibling sweep ticked and completed regardless.
    expect(prune).toHaveBeenCalledTimes(1);
    expect(cleanupSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(out).toHaveBeenCalledWith(
      expect.stringContaining("closed pull cleanup sweep completed"),
    );
    expect(out).not.toHaveBeenCalledWith(
      expect.stringContaining("worktree prune sweep completed"),
    );

    releasePrune();
    await vi.advanceTimersByTimeAsync(10);
    expect(out).toHaveBeenCalledWith(
      expect.stringContaining("worktree prune sweep completed"),
    );
    expect(prune).toHaveBeenCalledTimes(2);
  } finally {
    stopPrune();
    stopCleanup();
    cleanupSpy.mockRestore();
    out.mockRestore();
    vi.useRealTimers();
  }
});

test("herdr snapshot sweep persists the snapshot every tick and logs capture failures", async () => {
  vi.useFakeTimers();
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const snapshotSpy = vi
    .spyOn(svc.terminal, "snapshotHerdrSessions")
    .mockResolvedValue({
      repos: 1,
      running_repos: 2,
      capture_failed_repos: 1,
      changed: true,
      captured_at: "2026-07-19T00:00:00.000Z",
    });
  const stop = M.startHerdrSnapshotSweep(10);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    // A repo whose agent list could not be read shows up in the operational log, not just in
    // the Agents page (#2142).
    expect(out).toHaveBeenCalledWith(
      expect.stringContaining(
        "herdr snapshot sweep completed duration_ms=0 repos=1 running_repos=2 capture_failed_repos=1 changed=1",
      ),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(snapshotSpy).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    out.mockRestore();
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
  const activeVerifySessionId = "99999999-0000-0000-0000-000000000728";
  S.registerAgentSession(
    sessionId,
    "workflow-step",
    sessionId,
    "executor #1-1",
    "claude-code",
    "workflow-step",
  );
  S.registerAgentSession(parentSessionId, "lh-workflow", parentSessionId);
  S.registerAgentSession(
    activeVerifySessionId,
    "workflow-step",
    activeVerifySessionId,
    "verifier #1-2",
    "claude-code",
    "workflow-step",
  );
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
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId,
  });
  S.appendWorkflowRunStepSession(run.id, "execute", sessionId);
  S.appendWorkflowRunStepSession(run.id, "verify", activeVerifySessionId);
  S.updateWorkflowRun(run.id, {
    currentStep: "verify",
    activeStep: "verify",
    activeSessionId: activeVerifySessionId,
  });
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
    costIncrementUsd: 10,
    costLimitUsd: 10,
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

  const stop = M.startUsageSweep(20, async () => svc.sessions.usageSync());
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
      usage_session_id: sessionId,
      active_step: "verify",
      active_session_id: activeVerifySessionId,
      pr_number: pull.number,
      limit_usd: 10,
      increment_usd: 10,
      next_limit_usd: 20,
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
