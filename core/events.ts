/** Event shape returned by events/list. */
export interface LoopEvent {
  id: number;
  type: string;
  repo?: string;
  actor: string;
  payload: unknown;
  created_at: string;
}

/** SQLite row shape — internal to store; convert before returning it over an API. */
type DbEventRow = {
  id: number;
  type: string;
  actor: string;
  payload: string;
  created_at: string;
  repo_id?: number | null;
};

/** Convert a persisted event row to the transport-neutral events/list wire shape. */
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
