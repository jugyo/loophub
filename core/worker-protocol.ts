// Increment only when persisted workflow events, instructions, receipts, handshakes, or another
// Web/CLI-to-worker coordination contract changes incompatibly.
export const WORKFLOW_WORKER_PROTOCOL_VERSION = 1;
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_HEARTBEAT_STALE_AFTER_MS = 15_000;

export interface WorkerRuntimeRecord {
  protocol_version: number;
  started_at: string;
  heartbeat_at: string;
}

export type WorkerCompatibility =
  | {
      status: "missing";
      required_protocol_version: number;
      observed_protocol_version: null;
      started_at: null;
      heartbeat_at: null;
      stale_at: null;
    }
  | {
      status: "compatible" | "incompatible" | "stale";
      required_protocol_version: number;
      observed_protocol_version: number;
      started_at: string;
      heartbeat_at: string;
      stale_at: string | null;
    };

export function workerCompatibility(
  runtime: WorkerRuntimeRecord | null,
  nowMs = Date.now(),
): WorkerCompatibility {
  if (runtime === null) {
    return {
      status: "missing",
      required_protocol_version: WORKFLOW_WORKER_PROTOCOL_VERSION,
      observed_protocol_version: null,
      started_at: null,
      heartbeat_at: null,
      stale_at: null,
    };
  }

  const heartbeatMs = Date.parse(runtime.heartbeat_at);
  const staleAt = Number.isFinite(heartbeatMs)
    ? new Date(heartbeatMs + WORKER_HEARTBEAT_STALE_AFTER_MS).toISOString()
    : null;
  if (
    !Number.isFinite(heartbeatMs) ||
    nowMs - heartbeatMs > WORKER_HEARTBEAT_STALE_AFTER_MS
  ) {
    return {
      status: "stale",
      required_protocol_version: WORKFLOW_WORKER_PROTOCOL_VERSION,
      observed_protocol_version: runtime.protocol_version,
      started_at: runtime.started_at,
      heartbeat_at: runtime.heartbeat_at,
      stale_at: staleAt,
    };
  }

  return {
    status:
      runtime.protocol_version === WORKFLOW_WORKER_PROTOCOL_VERSION
        ? "compatible"
        : "incompatible",
    required_protocol_version: WORKFLOW_WORKER_PROTOCOL_VERSION,
    observed_protocol_version: runtime.protocol_version,
    started_at: runtime.started_at,
    heartbeat_at: runtime.heartbeat_at,
    stale_at: staleAt,
  };
}
