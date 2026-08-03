import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkerCompatibility } from "@/api/types";

const workerState = vi.hoisted(() => ({
  status: undefined as WorkerCompatibility | undefined,
  isError: false,
}));

vi.mock("@/queries/worker-status", () => ({
  useWorkerLaunchGate: () => ({
    data: workerState.status,
    isError: workerState.isError,
    showRemediation:
      workerState.isError ||
      (workerState.status !== undefined &&
        workerState.status.status !== "compatible"),
  }),
}));

import { WorkerCompatibilityWarning } from "./worker-compatibility-warning";

afterEach(() => {
  cleanup();
  workerState.status = undefined;
  workerState.isError = false;
});

it("stays hidden for a compatible worker", () => {
  workerState.status = {
    status: "compatible",
    required_protocol_version: 1,
    observed_protocol_version: 1,
    started_at: "2026-08-02T00:00:00Z",
    heartbeat_at: "2026-08-02T00:00:01Z",
    stale_at: "2026-08-02T00:00:16Z",
  } as WorkerCompatibility;
  render(<WorkerCompatibilityWarning />);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("treats a refetch error as unavailable even with cached compatible data", () => {
  workerState.status = {
    status: "compatible",
    required_protocol_version: 1,
    observed_protocol_version: 1,
    started_at: "2026-08-02T00:00:00Z",
    heartbeat_at: "2026-08-02T00:00:01Z",
    stale_at: "2026-08-02T00:00:16Z",
  };
  workerState.isError = true;
  render(<WorkerCompatibilityWarning />);

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Worker status is unavailable");
  expect(alert.textContent).toContain("Required protocol: 1");
  expect(alert.textContent).toContain("Observed protocol: 1");
  expect(alert.textContent).not.toContain("incompatible workflow protocol");
});

it("stays hidden before the first status response", () => {
  render(<WorkerCompatibilityWarning />);

  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([
  ["missing", null, "not running"],
  ["stale", 1, "heartbeat is stale"],
  ["incompatible", 2, "incompatible workflow protocol"],
] as const)("persistently explains the %s state with protocol and timing details", (status, observed, message) => {
  workerState.status = {
    status,
    required_protocol_version: 1,
    observed_protocol_version: observed,
    started_at: observed === null ? null : "2026-08-02T00:00:00Z",
    heartbeat_at: observed === null ? null : "2026-08-02T00:00:01Z",
    stale_at: observed === null ? null : "2026-08-02T00:00:16Z",
  } as WorkerCompatibility;
  render(<WorkerCompatibilityWarning />);

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain(message);
  expect(alert.textContent).toContain("Required protocol: 1");
  expect(alert.textContent).toContain(
    `Observed protocol: ${observed ?? "unknown"}`,
  );
  if (observed !== null) {
    expect(alert.textContent).toContain("Worker started: 2026-08-02T00:00:00Z");
    expect(alert.textContent).toContain("Last heartbeat: 2026-08-02T00:00:01Z");
  }
});
