import { db, now } from "../db.ts";
import type { ModelUsage, SubagentUsage } from "../session-usage.ts";

export interface SessionUsageRow {
  session_id: string;
  model: string;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  context_usage_percent?: number | null;
  updated_at: string;
}

export interface SessionSubagentUsageRow extends SessionUsageRow {
  source_id: string;
  parent_source_id: string | null;
  label: string | null;
  kind: string;
}

export interface SessionUsageCursorRow {
  session_id: string;
  transcript_path: string;
  cursor_offset: number;
  mtime_ms: number;
  updated_at: string;
}

// ---- session usage ----
export function listSessionUsage(sessionId: string): SessionUsageRow[] {
  return db
    .query(
      `SELECT *
       FROM session_usage
       WHERE session_id = ?
       ORDER BY model`,
    )
    .all(sessionId) as SessionUsageRow[];
}

export function listSessionSubagentUsage(
  sessionId: string,
): SessionSubagentUsageRow[] {
  return db
    .query(
      `SELECT *
       FROM session_usage_subagents
       WHERE session_id = ?
       ORDER BY source_id, model`,
    )
    .all(sessionId) as SessionSubagentUsageRow[];
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

export function deleteSessionSubagentUsageByKind(
  sessionId: string,
  kind: string,
) {
  db.run(
    `DELETE FROM session_usage_subagents
     WHERE session_id = ? AND kind = ?`,
    [sessionId, kind],
  );
}

export function listAllSessionUsage(): SessionUsageRow[] {
  return db
    .query(
      `SELECT *
       FROM session_usage
       ORDER BY session_id, model`,
    )
    .all() as SessionUsageRow[];
}

export interface SessionUsageTotals {
  total_tokens: number;
  cost_usd: number | null;
}

// Single aggregate query across every session linked to an issues row (issue or PR), used by the
// issue-list PR sub-row (#783) where per-session/per-model joins (listSessionsForIssue +
// listSessionUsage) would be an N+1 on top of the existing per-PR git fan-out. Returns null when no
// linked session has usage yet, so callers can omit the field entirely rather than show a zero.
export function sessionUsageTotalsForIssue(
  issueId: number,
): SessionUsageTotals | null {
  const row = db
    .query(
      `SELECT
         SUM(su.input_tokens) AS input_tokens,
         SUM(su.cache_creation_input_tokens) AS cache_creation_input_tokens,
         SUM(su.cache_read_input_tokens) AS cache_read_input_tokens,
         SUM(su.output_tokens) AS output_tokens,
         SUM(su.cost_usd) AS cost_usd_sum,
         SUM(CASE WHEN su.cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost_rows,
         COUNT(*) AS row_count
       FROM session_links l
       JOIN session_usage su ON su.session_id = l.session_id
       WHERE l.issue_id = ?`,
    )
    .get(issueId) as {
    input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
    output_tokens: number | null;
    cost_usd_sum: number | null;
    unknown_cost_rows: number;
    row_count: number;
  };
  if (row.row_count === 0) return null;
  const total_tokens =
    (row.input_tokens ?? 0) +
    (row.cache_creation_input_tokens ?? 0) +
    (row.cache_read_input_tokens ?? 0) +
    (row.output_tokens ?? 0);
  const cost_usd = row.unknown_cost_rows > 0 ? null : (row.cost_usd_sum ?? 0);
  return { total_tokens, cost_usd };
}

// Top-level cumulative cost (USD) for a single session, summed across its per-model `session_usage`
// rows. This reads the top-level total only — never `session_usage_subagents` — matching #832's
// rule to base the cost-stop decision on top-level usage and not fall back to subagent usage.
// Returns null when the cost is indeterminate: no usage rows yet (nothing to judge), or any row has
// an unknown (null) cost from an unpriced model — the cost-stop sweep treats null as "don't stop".
export function sessionUsageCostForSession(sessionId: string): number | null {
  const row = db
    .query(
      `SELECT
         SUM(cost_usd) AS cost_usd_sum,
         SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost_rows,
         COUNT(*) AS row_count
       FROM session_usage
       WHERE session_id = ?`,
    )
    .get(sessionId) as {
    cost_usd_sum: number | null;
    unknown_cost_rows: number;
    row_count: number;
  };
  if (row.row_count === 0 || row.unknown_cost_rows > 0) return null;
  return row.cost_usd_sum ?? 0;
}

export function getSessionUsageCursor(
  sessionId: string,
): SessionUsageCursorRow | null {
  return db
    .query(`SELECT * FROM session_usage_cursors WHERE session_id = ?`)
    .get(sessionId) as SessionUsageCursorRow | null;
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
        cache_read_input_tokens, output_tokens, cost_usd, context_usage_percent, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, model) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       cache_creation_input_tokens =
         cache_creation_input_tokens + excluded.cache_creation_input_tokens,
       cache_read_input_tokens =
         cache_read_input_tokens + excluded.cache_read_input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_usd = excluded.cost_usd,
       context_usage_percent = CASE
         WHEN context_usage_percent IS NULL THEN excluded.context_usage_percent
         WHEN excluded.context_usage_percent IS NULL THEN context_usage_percent
         ELSE MAX(context_usage_percent, excluded.context_usage_percent)
       END,
       updated_at = excluded.updated_at`,
    [
      sessionId,
      usage.model,
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
      usage.output_tokens,
      usage.cost_usd,
      usage.context_usage_percent ?? null,
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
