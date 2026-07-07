import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-worker-maintenance-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let M: typeof import("./maintenance.ts");

beforeAll(async () => {
  M = await import("./maintenance.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("maintenance loop options keep 0 as disabled and default invalid values", () => {
  expect(
    M.normalizeMaintenanceLoopOptions({
      sweepMs: 0,
      usageSweepMs: Number.NaN,
      herdrInactiveCleanupMs: Number.POSITIVE_INFINITY,
      githubMergeSweepMs: 0,
      costStopSweepMs: Number.NaN,
    }),
  ).toEqual({
    sweepMs: 0,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    herdrInactiveCleanupMs: M.DEFAULT_HERDR_INACTIVE_CLEANUP_MS,
    githubMergeSweepMs: 0,
    costStopSweepMs: M.DEFAULT_COST_STOP_SWEEP_MS,
  });

  expect(M.normalizeMaintenanceLoopOptions()).toEqual({
    sweepMs: M.DEFAULT_SWEEP_MS,
    usageSweepMs: M.DEFAULT_USAGE_SWEEP_MS,
    herdrInactiveCleanupMs: M.DEFAULT_HERDR_INACTIVE_CLEANUP_MS,
    githubMergeSweepMs: M.DEFAULT_GITHUB_MERGE_SWEEP_MS,
    costStopSweepMs: M.DEFAULT_COST_STOP_SWEEP_MS,
  });
});

test("maintenance summary reports disabled loops as off", () => {
  expect(
    M.maintenanceSummary({
      sweepMs: 0,
      usageSweepMs: 25,
      herdrInactiveCleanupMs: 0,
      githubMergeSweepMs: 0,
      costStopSweepMs: 0,
    }),
  ).toEqual({
    pullSweep: "off",
    usageSweep: "25ms",
    herdrInactiveCleanup: "off",
    githubMergeSweep: "off",
    costStopSweep: "off",
  });
});
