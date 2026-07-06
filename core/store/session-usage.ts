import { db, now } from "../db.ts";
import type { ModelUsage, SubagentUsage } from "../session-usage.ts";

// ---- session usage ----
export function listSessionUsage(sessionId: string): any[] {
  return db
    .query(
      `SELECT *
       FROM session_usage
       WHERE session_id = ?
       ORDER BY model`,
    )
    .all(sessionId);
}

export function listSessionSubagentUsage(sessionId: string): any[] {
  return db
    .query(
      `SELECT *
       FROM session_usage_subagents
       WHERE session_id = ?
       ORDER BY source_id, model`,
    )
    .all(sessionId);
}

export function hasSessionSubagentUsage(sessionId: string): boolean {
  return !!db
    .query(
      `SELECT 1 AS ok
       FROM session_usage_subagents
       WHERE session_id = ?
       LIMIT 1`,
    )
    .get(sessionId);
}

export function listAllSessionUsage(): any[] {
  return db
    .query(
      `SELECT *
       FROM session_usage
       ORDER BY session_id, model`,
    )
    .all();
}

export function getSessionUsageCursor(sessionId: string): any | null {
  return (
    db
      .query(`SELECT * FROM session_usage_cursors WHERE session_id = ?`)
      .get(sessionId) ?? null
  );
}

export function resetSessionUsage(sessionId: string) {
  db.run(`DELETE FROM session_usage WHERE session_id = ?`, [sessionId]);
  db.run(`DELETE FROM session_usage_subagents WHERE session_id = ?`, [
    sessionId,
  ]);
  db.run(`DELETE FROM session_usage_cursors WHERE session_id = ?`, [sessionId]);
  db.run(`DELETE FROM session_usage_messages WHERE session_id = ?`, [
    sessionId,
  ]);
}

export function insertSessionUsageMessage(
  sessionId: string,
  messageId: string,
): boolean {
  const before = db
    .query(
      `SELECT 1 AS ok FROM session_usage_messages
       WHERE session_id = ? AND message_id = ?`,
    )
    .get(sessionId, messageId);
  if (before) return false;
  db.run(
    `INSERT INTO session_usage_messages (session_id, message_id)
     VALUES (?, ?)`,
    [sessionId, messageId],
  );
  return true;
}

export function upsertSessionUsage(sessionId: string, usage: ModelUsage) {
  const t = now();
  db.run(
    `INSERT INTO session_usage
       (session_id, model, input_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, output_tokens, cost_usd, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, model) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       cache_creation_input_tokens =
         cache_creation_input_tokens + excluded.cache_creation_input_tokens,
       cache_read_input_tokens =
         cache_read_input_tokens + excluded.cache_read_input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_usd = excluded.cost_usd,
       updated_at = excluded.updated_at`,
    [
      sessionId,
      usage.model,
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
      usage.output_tokens,
      usage.cost_usd,
      t,
    ],
  );
}

export function upsertSessionSubagentUsage(
  sessionId: string,
  usage: SubagentUsage,
) {
  db.run(
    `INSERT INTO session_usage_subagents
       (session_id, source_id, parent_source_id, label, kind, model,
        input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        output_tokens, cost_usd, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, source_id, model) DO UPDATE SET
       parent_source_id = excluded.parent_source_id,
       label = excluded.label,
       kind = excluded.kind,
       input_tokens = excluded.input_tokens,
       cache_creation_input_tokens = excluded.cache_creation_input_tokens,
       cache_read_input_tokens = excluded.cache_read_input_tokens,
       output_tokens = excluded.output_tokens,
       cost_usd = excluded.cost_usd,
       updated_at = excluded.updated_at`,
    [
      sessionId,
      usage.source_id,
      usage.parent_source_id,
      usage.label,
      usage.kind,
      usage.model,
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
      usage.output_tokens,
      usage.cost_usd,
      now(),
    ],
  );
}

export function rewriteSessionUsageCost(
  sessionId: string,
  model: string,
  cost: number | null,
) {
  db.run(
    `UPDATE session_usage SET cost_usd = ?, updated_at = ? WHERE session_id = ? AND model = ?`,
    [cost, now(), sessionId, model],
  );
}

export function upsertSessionUsageCursor(input: {
  sessionId: string;
  transcriptPath: string;
  cursorOffset: number;
  mtimeMs: number;
}) {
  db.run(
    `INSERT INTO session_usage_cursors
       (session_id, transcript_path, cursor_offset, mtime_ms, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       transcript_path = excluded.transcript_path,
       cursor_offset = excluded.cursor_offset,
       mtime_ms = excluded.mtime_ms,
       updated_at = excluded.updated_at`,
    [
      input.sessionId,
      input.transcriptPath,
      input.cursorOffset,
      input.mtimeMs,
      now(),
    ],
  );
}
