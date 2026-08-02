import { TriangleAlert } from "lucide-react";
import type { WorkerCompatibility } from "@/api/types";
import { useWorkerLaunchGate } from "@/queries/worker-status";

export function workerRemediation(status: WorkerCompatibility): string {
  if (status.status === "missing")
    return "lh-worker is not running. Start lh-worker before starting workflows.";
  if (status.status === "stale")
    return "lh-worker heartbeat is stale. Restart lh-worker before starting workflows.";
  return "lh-worker uses an incompatible workflow protocol. Restart lh-worker before starting workflows.";
}

export function WorkerCompatibilityWarning() {
  const { data: status, isError, showRemediation } = useWorkerLaunchGate();
  if (!showRemediation) return null;

  return (
    <div
      data-debug-component="WorkerCompatibilityWarning"
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive sm:px-6"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {status ? (
        <div className="min-w-0">
          <div className="font-medium">
            {isError
              ? "Worker status is unavailable. Start or restart lh-worker before starting workflows."
              : workerRemediation(status)}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
            <span>Required protocol: {status.required_protocol_version}</span>
            <span>
              Observed protocol: {status.observed_protocol_version ?? "unknown"}
            </span>
            {status.started_at ? (
              <span>Worker started: {status.started_at}</span>
            ) : null}
            {status.heartbeat_at ? (
              <span>Last heartbeat: {status.heartbeat_at}</span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="font-medium">
          Worker compatibility is not confirmed. Start or restart lh-worker
          before starting workflows.
        </div>
      )}
    </div>
  );
}

export function WorkerLaunchUnavailable({ compact = false }) {
  return (
    <span
      className={
        compact ? "text-[11px] text-destructive" : "text-xs text-destructive"
      }
    >
      Start or restart lh-worker to enable workflow launches.
    </span>
  );
}
