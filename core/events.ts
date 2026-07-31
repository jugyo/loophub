import { eventSubject } from "./event-subjects.ts";
import type { LoopEventWire } from "./serialize.ts";

/** Event shape returned by events/list. The wire shape itself is owned by core/serialize.ts. */
export type LoopEvent = LoopEventWire;

/** SQLite row shape — internal to store; convert before returning it over an API. */
type DbEventRow = {
  id: number;
  type: string;
  actor: string;
  payload: string;
  created_at: string;
  repo_id?: number | null;
};

/**
 * Convert a persisted event row to the transport-neutral events/list wire shape.
 *
 * The subject is normalized here, once, so no consumer has to know which payload key names the
 * event's Issue, PR, Workflow run, or scheduled task.
 */
export function formatEvent(row: DbEventRow, repoFullName?: string): LoopEvent {
  const payload: unknown = JSON.parse(row.payload);
  return {
    id: row.id,
    type: row.type,
    repo: repoFullName,
    actor: row.actor,
    payload,
    subject: eventSubject(row.type, payload),
    created_at: row.created_at,
  };
}
