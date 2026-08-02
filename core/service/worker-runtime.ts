import { workerCompatibilityJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { WORKFLOW_WORKER_PROTOCOL_VERSION } from "../worker-protocol.ts";

export const workerRuntime = {
  heartbeat(startedAt: string, heartbeatAt = new Date().toISOString()): void {
    S.upsertWorkerRuntime({
      protocol_version: WORKFLOW_WORKER_PROTOCOL_VERSION,
      started_at: startedAt,
      heartbeat_at: heartbeatAt,
    });
  },

  status(nowMs = Date.now()) {
    return workerCompatibilityJSON(S.getWorkerRuntime(), nowMs);
  },
};
