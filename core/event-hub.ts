/**
 * Event delivery hub (in-process pub/sub).
 *
 * Layering:
 * - DbEventRow (store): repo_id + payload JSON string — never expose over HTTP.
 * - LoopEvent (this module): wire format for GET /events, hub subscribers, future SSE (#36).
 *
 * SSE (#36): subscribe here, push LoopEvent frames only. Reuse eventsPageLimit and the
 * same since/repo filter as GET /events — do not expose subscribe over HTTP or add a
 * separate wire type.
 */
export interface LoopEvent {
  id: number;
  type: string;
  repo?: string;
  actor: string;
  payload: unknown;
  created_at: string;
}

/** SQLite row shape — internal to store; convert via formatEvent before leaving the process. */
type DbEventRow = {
  id: number;
  type: string;
  actor: string;
  payload: string;
  created_at: string;
  repo_id?: number | null;
};

type Listener = (event: LoopEvent) => void;

const listeners = new Set<Listener>();

/** DB row → LoopEvent. Pass repo full_name when repo_id is set (see emitEvent / GET /events). */
export function formatEvent(row: DbEventRow, repoFullName?: string): LoopEvent {
  return {
    id: row.id,
    type: row.type,
    repo: repoFullName,
    actor: row.actor,
    payload: JSON.parse(row.payload),
    created_at: row.created_at,
  };
}

/** In-process only. SSE (#36) registers a listener server-side; clients never call this. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishEvent(event: LoopEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error("event-hub listener error:", e);
    }
  }
}

/** Test helper — not part of the public API surface for clients. */
export function listenerCount(): number {
  return listeners.size;
}
