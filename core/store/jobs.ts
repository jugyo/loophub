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
