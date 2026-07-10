import { db, now } from "../db.ts";

export type NotificationKind =
  | "implementation_done"
  | "over_budget"
  | "human_attention";
export type NotificationResourceKind = "issue" | "pull" | "repo";

export interface NotificationInput {
  repoId: number;
  kind: NotificationKind;
  title: string;
  body: string;
  resourceKind: NotificationResourceKind;
  resourceNumber?: number | null;
  sourceKey: string;
  herdrPaneId?: string | null;
  createdAt?: string | null;
}

export interface NotificationRow {
  id: number;
  repo_id: number;
  kind: NotificationKind;
  title: string;
  body: string;
  resource_kind: NotificationResourceKind;
  resource_number: number | null;
  source_key: string;
  herdr_pane_id: string | null;
  read_at: string | null;
  created_at: string;
}

export function createNotification(
  input: NotificationInput,
): NotificationRow | null {
  const row = db
    .query(
      `INSERT OR IGNORE INTO notifications
        (repo_id, kind, title, body, resource_kind, resource_number, source_key, herdr_pane_id, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       RETURNING *`,
    )
    .get(
      input.repoId,
      input.kind,
      input.title,
      input.body,
      input.resourceKind,
      input.resourceNumber ?? null,
      input.sourceKey,
      input.herdrPaneId ?? null,
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

export function listNotifications(opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 50;
  return db
    .query(
      `SELECT n.* FROM notifications n
       JOIN repos r ON r.id = n.repo_id
       LEFT JOIN issues i ON i.repo_id = n.repo_id
        AND i.number = n.resource_number
        AND i.kind = n.resource_kind
        AND n.resource_kind IN ('issue', 'pull')
       WHERE r.archived = 0
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
  source_key: string;
  created_at: string;
}

export interface NotificationSourceCursors {
  events: number;
  reviews: number;
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
                'implementation_done' AS kind,
                'ready:' || r.id || ':' || i.number || ':' || e.id AS source_key,
                e.created_at AS created_at
         FROM events e
         JOIN repos r ON r.id = e.repo_id
         JOIN issues i ON i.repo_id = r.id
          AND i.kind = 'pull'
          AND i.number = json_extract(e.payload, '$.number')
         JOIN pulls p ON p.issue_id = i.id
         WHERE e.type = 'pull_request.ready_for_review'
           AND e.id > ?
           AND e.id <= ?
           AND p.merged = 0
         UNION ALL
         SELECT r.id AS repo_id, r.full_name AS repo_full_name, i.number, i.title,
                'over_budget' AS kind,
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
                'changes:' || r.id || ':' || i.number || ':' || rv.id AS source_key,
                rv.created_at AS created_at
         FROM reviews rv
         JOIN issues i ON i.id = rv.issue_id AND i.kind = 'pull'
         JOIN pulls p ON p.issue_id = i.id
         JOIN repos r ON r.id = i.repo_id
         JOIN (
           SELECT issue_id, COALESCE(topic, char(0)) AS topic_key, MAX(id) AS latest_id
           FROM reviews
           WHERE event IN ('PASS', 'REQUEST_CHANGES')
           GROUP BY issue_id, COALESCE(topic, char(0))
         ) latest ON latest.latest_id = rv.id
         WHERE rv.event = 'REQUEST_CHANGES'
           AND rv.id > ?
           AND rv.id <= ?
           AND p.merged = 0
           AND p.changes_addressed_at IS NULL
       ) signals
       ORDER BY signals.created_at ASC`,
    )
    .all(
      cursors.events,
      highWatermarks.events,
      cursors.events,
      highWatermarks.events,
      cursors.reviews,
      highWatermarks.reviews,
    ) as NotificationSignalRow[];
}
