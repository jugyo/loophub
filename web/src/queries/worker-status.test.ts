import { describe, expect, test } from "vitest";
import type { WorkerCompatibility } from "@/api/types";
import { workerLaunchGate, workerStatusRefreshInterval } from "./worker-status";

const compatible: WorkerCompatibility = {
  status: "compatible",
  required_protocol_version: 1,
  observed_protocol_version: 1,
  started_at: "2026-08-02T00:00:00Z",
  heartbeat_at: "2026-08-02T00:00:01Z",
  stale_at: "2026-08-02T00:00:16Z",
};

describe("workerLaunchGate", () => {
  test("allows a confirmed compatible status", () => {
    expect(workerLaunchGate(compatible, false)).toEqual({
      canStartWorkflow: true,
      showRemediation: false,
    });
  });

  test("blocks cached compatible data when its refetch failed", () => {
    expect(workerLaunchGate(compatible, true)).toEqual({
      canStartWorkflow: false,
      showRemediation: true,
    });
  });

  test("hides remediation while compatibility is not yet confirmed", () => {
    expect(workerLaunchGate(undefined, false)).toEqual({
      canStartWorkflow: false,
      showRemediation: false,
    });
  });
});

describe("workerStatusRefreshInterval", () => {
  test("schedules compatible data once at its core-derived freshness deadline", () => {
    expect(
      workerStatusRefreshInterval(
        compatible,
        Date.parse("2026-08-02T00:00:10Z"),
      ),
    ).toBe(6_001);
  });

  test("does not continuously refresh a non-compatible status", () => {
    expect(
      workerStatusRefreshInterval({ ...compatible, status: "stale" }),
    ).toBe(false);
  });
});
