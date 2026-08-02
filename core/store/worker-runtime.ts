import { db } from "../db.ts";
import type { WorkerRuntimeRecord } from "../worker-protocol.ts";

export function getWorkerRuntime(): WorkerRuntimeRecord | null {
  return db
    .query(
      `SELECT protocol_version, started_at, heartbeat_at
       FROM worker_runtime
       WHERE singleton = 1`,
    )
    .get() as WorkerRuntimeRecord | null;
}

export function upsertWorkerRuntime(runtime: WorkerRuntimeRecord): void {
  db.run(
    `INSERT INTO worker_runtime
       (singleton, protocol_version, started_at, heartbeat_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET
       protocol_version = excluded.protocol_version,
       started_at = excluded.started_at,
       heartbeat_at = excluded.heartbeat_at`,
    [runtime.protocol_version, runtime.started_at, runtime.heartbeat_at],
  );
}
