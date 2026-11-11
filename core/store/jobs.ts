import { db, now } from "../db.ts";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRow {
  id: number;
  type: string;
  repo_id: number | null;
  dedupe_key: string;
  params: string;
  status: JobStatus;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
}

export function enqueue(input: {
  type: string;
  repoId?: number | null;
  dedupeKey: string;
  params: unknown;
}): number {
  const createdAt = now();
  db.run(
    `INSERT INTO jobs
       (type, repo_id, dedupe_key, params, status, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
    [
      input.type,
      input.repoId ?? null,
      input.dedupeKey,
      JSON.stringify(input.params),
      createdAt,
    ],
  );
  const row = db
    .query("SELECT id FROM jobs WHERE dedupe_key = ?")
    .get(input.dedupeKey) as { id: number };
  return row.id;
}

export function claimNext(): JobRow | null {
  return db.transaction(() => {
    const queued = db
      .query(
        `SELECT id FROM jobs
         WHERE status = 'queued'
         ORDER BY created_at, id
         LIMIT 1`,
      )
      .get() as { id: number } | null;
    if (!queued) return null;
    const startedAt = now();
    db.run(
      `UPDATE jobs
       SET status = 'running', started_at = ?, heartbeat_at = ?
       WHERE id = ? AND status = 'queued'`,
      [startedAt, startedAt, queued.id],
    );
    return db.query("SELECT * FROM jobs WHERE id = ?").get(queued.id) as JobRow;
  });
}

export function heartbeat(id: number): void {
  db.run(
    "UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'",
    [now(), id],
  );
}

export function finish(
  id: number,
  input: { status: "done" | "failed"; result?: unknown; error?: string },
): void {
  db.run(
    `UPDATE jobs
     SET status = ?, result = ?, error = ?, finished_at = ?, heartbeat_at = ?
     WHERE id = ? AND status = 'running'`,
    [
      input.status,
      input.result === undefined ? null : JSON.stringify(input.result),
      input.error ?? null,
      now(),
      now(),
      id,
    ],
  );
}

/** The newest job whose dedupe key starts with `keyPrefix`. */
export function latestByKeyPrefix(keyPrefix: string): JobRow | null {
  return db
    .query(
      `SELECT * FROM jobs WHERE substr(dedupe_key, 1, ?) = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(keyPrefix.length, keyPrefix) as JobRow | null;
}

export function get(id: number): JobRow | null {
  return db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
}

// A `running` row whose heartbeat stopped belongs to a queue process that died without finishing
// it. The command may already have produced external side effects, so the row is failed for an
// operator to inspect instead of being requeued.
// `liveIds` are jobs the calling process is still running, which a paused clock must not fail.
export function failStale(
  heartbeatBefore: string,
  liveIds: number[],
  error: string,
): JobRow[] {
  return db.transaction(() => {
    const live = new Set(liveIds);
    const stale = (
      db
        .query(
          `SELECT * FROM jobs
           WHERE status = 'running' AND heartbeat_at < ?
           ORDER BY id`,
        )
        .all(heartbeatBefore) as JobRow[]
    ).filter((job) => !live.has(job.id));
    for (const job of stale) finish(job.id, { status: "failed", error });
    return stale;
  });
}
