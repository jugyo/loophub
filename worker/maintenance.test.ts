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
      costStopSweepMs: Number.NaN,
      closedPullCleanupSweepMs: Number.NaN,
      scheduledTaskSweepMs: Number.NaN,
      conflictSweepMs: Number.NaN,
    }),
  ).toEqual({
    sweepMs: 0,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    githubMergeSweepMs: 0,
    costStopSweepMs: M.DEFAULT_COST_STOP_SWEEP_MS,
    closedPullCleanupSweepMs: M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    scheduledTaskSweepMs: M.DEFAULT_SCHEDULED_TASK_SWEEP_MS,
    conflictSweepMs: M.DEFAULT_CONFLICT_SWEEP_MS,
  });

  expect(M.normalizeMaintenanceLoopOptions()).toEqual({
    sweepMs: M.DEFAULT_SWEEP_MS,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    githubMergeSweepMs: M.DEFAULT_GITHUB_MERGE_SWEEP_MS,
    costStopSweepMs: M.DEFAULT_COST_STOP_SWEEP_MS,
    closedPullCleanupSweepMs: M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    scheduledTaskSweepMs: M.DEFAULT_SCHEDULED_TASK_SWEEP_MS,
    conflictSweepMs: M.DEFAULT_CONFLICT_SWEEP_MS,
  });
});

test("closed PR cleanup defaults to a coarser interval than cost stop", () => {
  expect(M.DEFAULT_COST_STOP_SWEEP_MS).toBe(30000);
  expect(M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS).toBe(600000);
});

test("maintenance summary reports disabled loops as off", () => {
  expect(
    M.maintenanceSummary({
      sweepMs: 0,
      usageSweepMs: 25,
      githubMergeSweepMs: 0,
      costStopSweepMs: 0,
      closedPullCleanupSweepMs: 600000,
      scheduledTaskSweepMs: 0,
      conflictSweepMs: 0,
    }),
  ).toEqual({
    pullSweep: "off",
    usageSweep: "25ms",
    githubMergeSweep: "off",
    costStopSweep: "off",
    closedPullCleanupSweep: "600000ms",
    scheduledTaskSweep: "off",
    conflictSweep: "off",
  });
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

test("cost stop sweep enforces cost limits without touching closed PR cleanup", async () => {
  vi.useFakeTimers();
  const costSpy = vi
    .spyOn(svc.terminal, "enforceDevCostLimits")
    .mockResolvedValue({ stopped: 0, skipped: 0, failed: 0 });
  const cleanupSpy = vi
    .spyOn(svc.terminal, "cleanupClosedPullDevAgents")
    .mockResolvedValue({ killed: 1, skipped: 0, failed: 0 });
  const stop = M.startCostStopSweep(10);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(costSpy).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).not.toHaveBeenCalled();
  } finally {
    stop();
    costSpy.mockRestore();
    cleanupSpy.mockRestore();
    vi.useRealTimers();
  }
});

test("closed pull cleanup sweep kills closed-PR agents without enforcing cost limits", async () => {
  vi.useFakeTimers();
  const costSpy = vi
    .spyOn(svc.terminal, "enforceDevCostLimits")
    .mockResolvedValue({ stopped: 0, skipped: 0, failed: 0 });
  const cleanupSpy = vi
    .spyOn(svc.terminal, "cleanupClosedPullDevAgents")
    .mockResolvedValue({ killed: 1, skipped: 0, failed: 0 });
  const stop = M.startClosedPullCleanupSweep(10);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(costSpy).not.toHaveBeenCalled();
  } finally {
    stop();
    costSpy.mockRestore();
    cleanupSpy.mockRestore();
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
  S.registerAgentSession(
    sessionId,
    "lh-build",
    sessionId,
    "dev agent",
    "claude-code",
    "dev",
  );
  const repo = S.createRepo("me/usage-sweep", "/tmp/lh-usage-sweep-repo");
  const pull = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(pull.id, "loophub/issue-724", "main", null);
  S.linkSession(sessionId, pull.id);

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

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(usageEvents()).toHaveLength(1);
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
