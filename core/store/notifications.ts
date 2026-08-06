import { db, now } from "../db.ts";
import type { MergeableState } from "../mergeable.ts";

// Single source of truth for notification kinds. TypeScript, store inserts, and service
// assertKind all derive from this list — SQLite no longer CHECKs kind so new values only need
// a code change (plus any UI/CLI labels that surface them).
export const NOTIFICATION_KINDS = [
  "merge_ready",
  "over_budget",
  "human_attention",
  "agent_comment",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type NotificationSeverity = "info" | "warning";
export type NotificationResourceKind = "issue" | "pull" | "repo";

const NOTIFICATION_KIND_SET: ReadonlySet<string> = new Set(NOTIFICATION_KINDS);

export function isNotificationKind(value: unknown): value is NotificationKind {
  return typeof value === "string" && NOTIFICATION_KIND_SET.has(value);
}

/** Oxford-comma list used in validation error messages (service + store). */
export function notificationKindAllowlistMessage(): string {
  // NOTIFICATION_KINDS is non-empty by construction; slice leaves every entry but the last
  // joined with commas, then "or <last>" for the same phrasing assertKind always used.
  return `${NOTIFICATION_KINDS.slice(0, -1).join(", ")}, or ${NOTIFICATION_KINDS[NOTIFICATION_KINDS.length - 1]}`;
}

export function assertNotificationKind(value: unknown): NotificationKind {
  if (isNotificationKind(value)) return value;
  throw new Error(`kind must be ${notificationKindAllowlistMessage()}`);
}

export interface NotificationInput {
  repoId: number;
  kind: NotificationKind;
  severity?: NotificationSeverity;
  title: string;
  body: string;
  resourceKind: NotificationResourceKind;
  resourceNumber?: number | null;
  sourceKey: string;
  herdrPaneId?: string | null;
  workflowRunId?: number | null;
  createdAt?: string | null;
}

export interface NotificationRow {
  id: number;
  repo_id: number;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  resource_kind: NotificationResourceKind;
  resource_number: number | null;
  source_key: string;
  herdr_pane_id: string | null;
  workflow_run_id: number | null;
  read_at: string | null;
  created_at: string;
}

export function createNotification(
  input: NotificationInput,
): NotificationRow | null {
  // Runtime guard for every INSERT path (service CLI, merge-ready sweep, agent comments).
  // TypeScript already narrows NotificationKind; this covers casts and keeps store/service
  // on the same allowlist after the SQLite kind CHECK was removed.
  assertNotificationKind(input.kind);
  const row = db
    .query(
      `INSERT OR IGNORE INTO notifications
        (repo_id, kind, severity, title, body, resource_kind, resource_number, source_key, herdr_pane_id, workflow_run_id, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       RETURNING *`,
    )
    .get(
      input.repoId,
      input.kind,
      input.severity ?? "info",
      input.title,
      input.body,
      input.resourceKind,
      input.resourceNumber ?? null,
      input.sourceKey,
      input.herdrPaneId ?? null,
      input.workflowRunId ?? null,
      input.createdAt ?? now(),
    ) as NotificationRow | null;
  return row ?? null;
}

export function getNotificationById(id: number): NotificationRow | null {
  return db
    .query(`SELECT * FROM notifications WHERE id = ?`)
    .get(id) as NotificationRow | null;
}

export function markNotificationRead(id: number): NotificationRow | null {
  const current = getNotificationById(id);
  if (!current) return null;
  if (current.read_at) return current;
  return db
    .query(`UPDATE notifications SET read_at = ? WHERE id = ? RETURNING *`)
    .get(now(), id) as NotificationRow | null;
}

export function markAllNotificationsRead(): NotificationRow[] {
  return db
    .query(
      `UPDATE notifications SET read_at = ?
       WHERE id IN (
         SELECT n.id FROM notifications n
         JOIN repos r ON r.id = n.repo_id
         LEFT JOIN issues i ON i.repo_id = n.repo_id
          AND i.number = n.resource_number
          AND i.kind = n.resource_kind
          AND n.resource_kind IN ('issue', 'pull')
         WHERE n.read_at IS NULL
           AND r.archived = 0
           AND (
             n.resource_kind = 'repo'
             OR i.id IS NULL
             OR i.state = 'open'
           )
       )
       RETURNING *`,
    )
    .all(now()) as NotificationRow[];
}

export function listNotifications(
  opts: { limit?: number; unreadOnly?: boolean } = {},
) {
  const limit = opts.unreadOnly ? -1 : (opts.limit ?? 50);
  const unreadFilter = opts.unreadOnly ? "AND n.read_at IS NULL" : "";
  return db
    .query(
      `SELECT n.* FROM notifications n
       JOIN repos r ON r.id = n.repo_id
       LEFT JOIN issues i ON i.repo_id = n.repo_id
        AND i.number = n.resource_number
        AND i.kind = n.resource_kind
        AND n.resource_kind IN ('issue', 'pull')
       WHERE r.archived = 0
         ${unreadFilter}
         AND (
           n.resource_kind = 'repo'
           OR i.id IS NULL
           OR i.state = 'open'
         )
       ORDER BY n.read_at IS NOT NULL ASC, n.created_at DESC, n.id DESC
       LIMIT ?`,
    )
    .all(limit) as NotificationRow[];
}

export function unreadNotificationCount(): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS n
       FROM notifications n
       JOIN repos r ON r.id = n.repo_id
       LEFT JOIN issues i ON i.repo_id = n.repo_id
        AND i.number = n.resource_number
        AND i.kind = n.resource_kind
        AND n.resource_kind IN ('issue', 'pull')
       WHERE n.read_at IS NULL
         AND r.archived = 0
         AND (
           n.resource_kind = 'repo'
           OR i.id IS NULL
           OR i.state = 'open'
         )`,
    )
    .get() as { n: number };
  return row.n;
}

export interface NotificationSignalRow {
  repo_id: number;
  repo_full_name: string;
  number: number;
  title: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  reason:
    | "cost_stopped"
    | "github_merged"
    | "workflow_cost_exceeded"
    | "workflow_rework_limit";
  workflow_run_id: number | null;
  issue_number: number | null;
  cost_usd: number | null;
  limit_usd: number | null;
  detail: string | null;
  source_key: string;
  created_at: string;
}

export interface NotificationSourceCursors {
  events: number;
  reviews: number;
}

export interface MergeReadyStateRow {
  state: MergeableState;
  transition_count: number;
  updated_at: string;
}

export function recordMergeReadyState(
  repoId: number,
  pullNumber: number,
  state: MergeableState,
): MergeReadyStateRow {
  const updatedAt = now();
  db.query(
    `INSERT INTO notification_merge_ready_states
       (repo_id, pull_number, state, transition_count, updated_at)
     VALUES (?, ?, ?, CASE WHEN ? = 'clean' THEN 1 ELSE 0 END, ?)
     ON CONFLICT(repo_id, pull_number) DO UPDATE SET
       state = excluded.state,
       transition_count = notification_merge_ready_states.transition_count +
         CASE
           WHEN notification_merge_ready_states.state <> 'clean' AND excluded.state = 'clean'
             THEN 1
           ELSE 0
         END,
       updated_at = excluded.updated_at
     WHERE notification_merge_ready_states.state <> excluded.state`,
  ).run(repoId, pullNumber, state, state, updatedAt);
  return db
    .query(
      `SELECT state, transition_count, updated_at
       FROM notification_merge_ready_states
       WHERE repo_id = ? AND pull_number = ?`,
    )
    .get(repoId, pullNumber) as MergeReadyStateRow;
}

export function notificationSourceHighWatermarks(): NotificationSourceCursors {
  const events = db
    .query(`SELECT COALESCE(MAX(id), 0) AS id FROM events`)
    .get() as { id: number };
  const reviews = db
    .query(`SELECT COALESCE(MAX(id), 0) AS id FROM reviews`)
    .get() as { id: number };
  return { events: events.id, reviews: reviews.id };
}

export function notificationSourceCursors(): NotificationSourceCursors {
  const events = db
    .query(`SELECT last_id FROM notification_cursors WHERE scope = 'events'`)
    .get() as { last_id: number } | null;
  const reviews = db
    .query(`SELECT last_id FROM notification_cursors WHERE scope = 'reviews'`)
    .get() as { last_id: number } | null;
  return { events: events?.last_id ?? 0, reviews: reviews?.last_id ?? 0 };
}

export function advanceNotificationSourceCursors(
  cursors: NotificationSourceCursors,
) {
  db.run(
    `INSERT INTO notification_cursors (scope, last_id)
     VALUES ('events', ?), ('reviews', ?)
     ON CONFLICT(scope) DO UPDATE SET last_id = MAX(notification_cursors.last_id, excluded.last_id)`,
    [cursors.events, cursors.reviews],
  );
}

export function listNotificationSignalRows(
  cursors: NotificationSourceCursors,
  highWatermarks: NotificationSourceCursors,
): NotificationSignalRow[] {
  return db
    .query(
      `SELECT * FROM (
         SELECT r.id AS repo_id, r.full_name AS repo_full_name, i.number, i.title,
                'over_budget' AS kind,
                'warning' AS severity,
                'cost_stopped' AS reason,
                NULL AS workflow_run_id,
                NULL AS issue_number,
                NULL AS cost_usd,
                NULL AS limit_usd,
                NULL AS detail,
                'cost:' || r.id || ':' || i.number || ':' || e.id AS source_key,
                e.created_at AS created_at
         FROM events e
         JOIN repos r ON r.id = e.repo_id
         JOIN issues i ON i.repo_id = r.id
          AND i.kind = 'pull'
          AND i.number = json_extract(e.payload, '$.number')
         JOIN pulls p ON p.issue_id = i.id
         WHERE e.type = 'dev.cost_stopped'
           AND e.id > ?
           AND e.id <= ?
           AND p.merged = 0
         UNION ALL
         SELECT r.id AS repo_id, r.full_name AS repo_full_name, i.number, i.title,
                'human_attention' AS kind,
                'info' AS severity,
                'github_merged' AS reason,
                NULL AS workflow_run_id,
                NULL AS issue_number,
                NULL AS cost_usd,
                NULL AS limit_usd,
                NULL AS detail,
                'github-merged:' || r.id || ':' || i.number || ':' || e.id AS source_key,
                e.created_at AS created_at
         FROM events e
         JOIN repos r ON r.id = e.repo_id
         JOIN issues i ON i.repo_id = r.id
          AND i.kind = 'pull'
          AND i.number = json_extract(e.payload, '$.number')
         JOIN pulls p ON p.issue_id = i.id
         WHERE e.type = 'pull_request.github_merged'
           AND e.id > ?
           AND e.id <= ?
           AND p.merged = 0
         UNION ALL
         SELECT r.id AS repo_id, r.full_name AS repo_full_name, i.number, i.title,
                'over_budget' AS kind,
                'warning' AS severity,
                'workflow_cost_exceeded' AS reason,
                wr.id AS workflow_run_id,
                wr.issue_number AS issue_number,
                json_extract(e.payload, '$.cost_usd') AS cost_usd,
                json_extract(e.payload, '$.limit_usd') AS limit_usd,
                NULL AS detail,
                'workflow-cost:' || r.id || ':' || wr.id || ':' ||
                  json_extract(e.payload, '$.limit_usd') AS source_key,
                e.created_at AS created_at
         FROM events e
         JOIN repos r ON r.id = e.repo_id
         JOIN workflow_runs wr ON wr.repo_id = r.id
          AND wr.id = json_extract(e.payload, '$.id')
         JOIN issues i ON i.repo_id = r.id
          AND i.kind = 'pull'
          AND i.number = wr.pr_number
         JOIN pulls p ON p.issue_id = i.id
         WHERE e.type = 'workflow_run.cost_exceeded'
           AND e.id > ?
           AND e.id <= ?
           AND p.merged = 0
         UNION ALL
         SELECT r.id AS repo_id, r.full_name AS repo_full_name, i.number, i.title,
                'human_attention' AS kind,
                'warning' AS severity,
                'workflow_rework_limit' AS reason,
                wr.id AS workflow_run_id,
                wr.issue_number AS issue_number,
                NULL AS cost_usd,
                NULL AS limit_usd,
                json_extract(e.payload, '$.reason') AS detail,
                'workflow-rework:' || r.id || ':' || wr.id || ':' || e.id AS source_key,
                e.created_at AS created_at
         FROM events e
         JOIN repos r ON r.id = e.repo_id
         JOIN workflow_runs wr ON wr.repo_id = r.id
          AND wr.id = json_extract(e.payload, '$.id')
         JOIN issues i ON i.repo_id = r.id
          AND i.kind = 'pull'
          AND i.number = wr.pr_number
         JOIN pulls p ON p.issue_id = i.id
         WHERE e.type = 'workflow_effect.human_escalation'
           AND json_extract(e.payload, '$.reason') LIKE '%rework limit%reached%'
           AND e.id > ?
           AND e.id <= ?
           AND p.merged = 0
       ) signals
       ORDER BY signals.created_at ASC`,
    )
    .all(
      cursors.events,
      highWatermarks.events,
      cursors.events,
      highWatermarks.events,
      cursors.events,
      highWatermarks.events,
      cursors.events,
      highWatermarks.events,
    ) as NotificationSignalRow[];
}
