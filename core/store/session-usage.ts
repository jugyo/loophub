import { db, now } from "../db.ts";
import type { ModelUsage, SubagentUsage } from "../session-usage.ts";
import { type SessionUsageSample, totalTokens } from "../session-usage-rate.ts";

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

export function tokenTotalsForSession(
  sessionId: string,
): { totalTokens: number; cacheReadTokens: number } | null {
  const row = db
    .query(
      `SELECT
         SUM(input_tokens) AS input_tokens,
         SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
         SUM(cache_read_input_tokens) AS cache_read_input_tokens,
         SUM(output_tokens) AS output_tokens,
         COUNT(*) AS row_count
       FROM session_usage
       WHERE session_id = ?`,
    )
    .get(sessionId) as {
    input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
    output_tokens: number | null;
    row_count: number;
  };
  if (row.row_count === 0) return null;
  const usage = {
    input_tokens: row.input_tokens ?? 0,
    cache_creation_input_tokens: row.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: row.cache_read_input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
  };
  return {
    totalTokens: totalTokens(usage),
    cacheReadTokens: usage.cache_read_input_tokens,
  };
}

export function recordSessionUsageSample(input: {
  sessionId: string;
  totalTokens: number;
  cacheReadTokens: number;
  observedAt?: string;
  /** Override auto non-cache delta (used by Grok turn-rate reconstruction). */
  tokenDelta?: number;
  /** Override auto cache-read delta (used by Grok turn-rate reconstruction). */
  cacheReadDelta?: number;
}): void {
  db.transaction(() => {
    const observedAt = input.observedAt ?? now();
    const previous = db
      .query(
        `SELECT total_tokens, cache_read_tokens
         FROM session_usage_samples
         WHERE session_id = ?
         ORDER BY observed_at DESC, id DESC
         LIMIT 1`,
      )
      .get(input.sessionId) as {
      total_tokens: number;
      cache_read_tokens: number;
    } | null;
    const rawDelta =
      previous == null
        ? 0
        : input.totalTokens -
          input.cacheReadTokens -
          (previous.total_tokens - previous.cache_read_tokens);
    const tokenDelta =
      input.tokenDelta != null
        ? Math.max(0, input.tokenDelta)
        : rawDelta > 0
          ? rawDelta
          : 0;
    const rawCacheReadDelta =
      previous == null ? 0 : input.cacheReadTokens - previous.cache_read_tokens;
    const cacheReadDelta =
      input.cacheReadDelta != null
        ? Math.max(0, input.cacheReadDelta)
        : rawCacheReadDelta > 0
          ? rawCacheReadDelta
          : 0;
    db.run(
      `INSERT INTO session_usage_samples
         (session_id, total_tokens, token_delta, cache_read_tokens, cache_read_delta, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId,
        input.totalTokens,
        tokenDelta,
        input.cacheReadTokens,
        cacheReadDelta,
        observedAt,
      ],
    );
  });
}

export function pruneSessionUsageSamples(before: string): void {
  db.run(`DELETE FROM session_usage_samples WHERE observed_at < ?`, [before]);
}

export interface SessionRateHistoryRow {
  id: number;
  tokens_per_second: number;
  observed_at: string;
}

// Persist one live aggregate tokens/sec value (#1123). Unlike session_usage_samples this is not pruned
// at the 600s sample TTL, so callers can reconstruct the historical rate time series later.
export function recordSessionRateHistory(input: {
  tokensPerSecond: number;
  observedAt?: string;
}): void {
  db.run(
    `INSERT INTO session_rate_history (tokens_per_second, observed_at)
     VALUES (?, ?)`,
    [input.tokensPerSecond, input.observedAt ?? now()],
  );
}

export function pruneSessionRateHistory(before: string): void {
  db.run(`DELETE FROM session_rate_history WHERE observed_at < ?`, [before]);
}

export function listSessionRateHistory(since: string): SessionRateHistoryRow[] {
  return db
    .query(
      `SELECT id, tokens_per_second, observed_at
       FROM session_rate_history
       WHERE observed_at >= ?
       ORDER BY observed_at, id`,
    )
    .all(since) as SessionRateHistoryRow[];
}

export function listRecentInProgressSessionUsageSamples(
  since: string,
): SessionUsageSample[] {
  return db
    .query(
      `SELECT sus.session_id, sus.total_tokens, sus.token_delta,
              sus.cache_read_tokens, sus.cache_read_delta, sus.observed_at
       FROM session_usage_samples sus
       WHERE sus.observed_at >= ?
         AND EXISTS (
           SELECT 1
           FROM session_links l
           JOIN agent_sessions s ON s.id = l.session_id
           JOIN issues i ON i.id = l.issue_id
           JOIN pulls p ON p.issue_id = i.id
           WHERE l.session_id = sus.session_id
             AND s.kind IN ('dev', 'workflow-step')
             AND i.kind = 'pull'
             AND i.state = 'open'
             AND p.merged = 0
             AND NOT EXISTS (
               SELECT 1
               FROM events e
               WHERE e.repo_id = i.repo_id
                 AND e.type = 'pull_request.ready_for_review'
                 AND json_extract(e.payload, '$.number') = i.number
             )
         )
       ORDER BY sus.observed_at, sus.id`,
    )
    .all(since) as SessionUsageSample[];
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

export interface SessionUsageCostSummary {
  cost_usd: number | null;
  unobserved_session_ids: string[];
  unknown_cost_session_ids: string[];
}

// Cumulative top-level cost for a set of sessions. Session ids are de-duplicated before querying
// because a Workflow parent can also appear in step history. A session with no usage yet contributes
// nothing: unlike an explicit NULL cost row, it does not make already-recorded costs indeterminate.
// The diagnostic lists let callers explain why no decision was possible.
export function sessionUsageCostSummaryForSessions(
  sessionIds: readonly string[],
): SessionUsageCostSummary {
  const unique = [...new Set(sessionIds)];
  let total = 0;
  let observed = 0;
  const unobservedSessionIds: string[] = [];
  const unknownCostSessionIds: string[] = [];
  for (const sessionId of unique) {
    const rows = listSessionUsage(sessionId);
    if (rows.length === 0) {
      unobservedSessionIds.push(sessionId);
      continue;
    }
    observed++;
    if (rows.some((row) => row.cost_usd === null)) {
      unknownCostSessionIds.push(sessionId);
      continue;
    }
    total += rows.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
  }
  return {
    cost_usd: observed === 0 || unknownCostSessionIds.length > 0 ? null : total,
    unobserved_session_ids: unobservedSessionIds,
    unknown_cost_session_ids: unknownCostSessionIds,
  };
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

export function deleteZeroTokenSessionUsageRows(sessionId?: string): void {
  const zeroTokenWhere = `input_tokens = 0
    AND cache_creation_input_tokens = 0
    AND cache_read_input_tokens = 0
    AND output_tokens = 0`;
  if (sessionId) {
    db.run(
      `DELETE FROM session_usage WHERE session_id = ? AND ${zeroTokenWhere}`,
      [sessionId],
    );
    db.run(
      `DELETE FROM session_usage_subagents WHERE session_id = ? AND ${zeroTokenWhere}`,
      [sessionId],
    );
    return;
  }
  db.run(`DELETE FROM session_usage WHERE ${zeroTokenWhere}`);
  db.run(`DELETE FROM session_usage_subagents WHERE ${zeroTokenWhere}`);
}

export function insertSessionUsageMessage(
  sessionId: string,
  messageId: string,
): boolean {
  if (hasSessionUsageMessage(sessionId, messageId)) return false;
  db.run(
    `INSERT INTO session_usage_messages (session_id, message_id)
     VALUES (?, ?)`,
    [sessionId, messageId],
  );
  return true;
}

export function hasSessionUsageMessage(
  sessionId: string,
  messageId: string,
): boolean {
  return Boolean(
    db
      .query(
        `SELECT 1 AS ok FROM session_usage_messages
         WHERE session_id = ? AND message_id = ?`,
      )
      .get(sessionId, messageId),
  );
}

function hasTokenUsage(usage: {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}): boolean {
  return (
    usage.input_tokens > 0 ||
    usage.cache_creation_input_tokens > 0 ||
    usage.cache_read_input_tokens > 0 ||
    usage.output_tokens > 0
  );
}

export function upsertSessionUsage(sessionId: string, usage: ModelUsage) {
  if (!hasTokenUsage(usage)) return;
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
  if (!hasTokenUsage(usage)) return;
  db.run(
    `INSERT INTO session_usage_subagents
       (session_id, source_id, parent_source_id, label, kind, model,
        input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
        output_tokens, cost_usd, context_usage_percent, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, source_id, model) DO UPDATE SET
       parent_source_id = excluded.parent_source_id,
       label = excluded.label,
       kind = excluded.kind,
       input_tokens = excluded.input_tokens,
       cache_creation_input_tokens = excluded.cache_creation_input_tokens,
       cache_read_input_tokens = excluded.cache_read_input_tokens,
       output_tokens = excluded.output_tokens,
       cost_usd = excluded.cost_usd,
       context_usage_percent = excluded.context_usage_percent,
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
      usage.context_usage_percent ?? null,
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
