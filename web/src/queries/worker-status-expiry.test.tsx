import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkerCompatibility } from "@/api/types";

const api = vi.hoisted(() => ({ getWorkerStatus: vi.fn() }));

vi.mock("@/api/client", () => ({ getWorkerStatus: api.getWorkerStatus }));

import { useWorkerLaunchGate } from "./worker-status";

const NOW = Date.parse("2026-08-02T00:00:00Z");
const compatible: WorkerCompatibility = {
  status: "compatible",
  required_protocol_version: 1,
  observed_protocol_version: 1,
  started_at: "2026-08-01T23:59:50Z",
  heartbeat_at: "2026-08-02T00:00:00Z",
  stale_at: "2026-08-02T00:00:15Z",
};

function Harness() {
  const { canStartWorkflow, data } = useWorkerLaunchGate();
  return (
    <button type="button" disabled={!canStartWorkflow}>
      {data?.status ?? "loading"}
    </button>
  );
}

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  api.getWorkerStatus.mockReset();
});

it("refreshes a compatible status and disables launch when the worker becomes stale", async () => {
  api.getWorkerStatus
    .mockResolvedValueOnce(compatible)
    .mockResolvedValueOnce({ ...compatible, status: "stale" });

  render(<Harness />, {
    wrapper: wrapper(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    ),
  });
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(
    false,
  );

  await act(() => vi.advanceTimersByTimeAsync(15_000));
  await act(() => vi.advanceTimersByTimeAsync(1));

  expect(api.getWorkerStatus).toHaveBeenCalledTimes(2);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button").textContent).toBe("stale");
});

it("does not retry a failed status request", async () => {
  api.getWorkerStatus.mockRejectedValue(new Error("status unavailable"));

  render(<Harness />, {
    wrapper: wrapper(new QueryClient()),
  });
  await act(() => vi.advanceTimersByTimeAsync(60_000));

  expect(api.getWorkerStatus).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
});
