import { useQuery } from "@tanstack/react-query";
import { getWorkerStatus } from "@/api/client";
import type { WorkerCompatibility } from "@/api/types";
import { queryKeys } from "./keys";

export function workerStatusRefreshInterval(
  status: WorkerCompatibility | undefined,
  nowMs = Date.now(),
): number | false {
  if (status?.status !== "compatible" || status.stale_at === null) return false;
  const staleAtMs = Date.parse(status.stale_at);
  return Number.isFinite(staleAtMs)
    ? Math.max(1, staleAtMs - nowMs + 1)
    : false;
}

export function useWorkerStatus() {
  return useQuery({
    queryKey: queryKeys.workerStatus(),
    queryFn: getWorkerStatus,
    retry: false,
    refetchInterval: (query) => workerStatusRefreshInterval(query.state.data),
    refetchOnWindowFocus: "always",
  });
}

export function workerLaunchGate(
  status: WorkerCompatibility | undefined,
  isError: boolean,
) {
  return {
    canStartWorkflow: !isError && status?.status === "compatible",
    showRemediation:
      status === undefined || isError || status.status !== "compatible",
  };
}

export function useWorkerLaunchGate() {
  const query = useWorkerStatus();
  return { ...query, ...workerLaunchGate(query.data, query.isError) };
}
