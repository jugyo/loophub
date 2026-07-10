import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-worker-maintenance-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let M: typeof import("./maintenance.ts");
let svc: typeof import("../core/service.ts");

beforeAll(async () => {
  M = await import("./maintenance.ts");
  svc = await import("../core/service.ts");
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

test("maintenance loop options keep 0 as disabled and default invalid values", () => {
  expect(
    M.normalizeMaintenanceLoopOptions({
      sweepMs: 0,
      usageSweepMs: Number.NaN,
      githubMergeSweepMs: 0,
      costStopSweepMs: Number.NaN,
      closedPullCleanupSweepMs: Number.NaN,
      scheduledTaskSweepMs: Number.NaN,
    }),
  ).toEqual({
    sweepMs: 0,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    githubMergeSweepMs: 0,
    costStopSweepMs: M.DEFAULT_COST_STOP_SWEEP_MS,
    closedPullCleanupSweepMs: M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    scheduledTaskSweepMs: M.DEFAULT_SCHEDULED_TASK_SWEEP_MS,
  });

  expect(M.normalizeMaintenanceLoopOptions()).toEqual({
    sweepMs: M.DEFAULT_SWEEP_MS,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    githubMergeSweepMs: M.DEFAULT_GITHUB_MERGE_SWEEP_MS,
    costStopSweepMs: M.DEFAULT_COST_STOP_SWEEP_MS,
    closedPullCleanupSweepMs: M.DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    scheduledTaskSweepMs: M.DEFAULT_SCHEDULED_TASK_SWEEP_MS,
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
    }),
  ).toEqual({
    pullSweep: "off",
    usageSweep: "25ms",
    githubMergeSweep: "off",
    costStopSweep: "off",
    closedPullCleanupSweep: "600000ms",
    scheduledTaskSweep: "off",
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
