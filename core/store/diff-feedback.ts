import { db, now } from "../db.ts";

export interface DiffFeedbackThreadRow {
  id: number;
  issue_id: number;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  path: string;
  original_path: string | null;
  side: string;
  start_line: number;
  end_line: number;
  status: string;
  created_by: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

export interface DiffFeedbackMessageRow {
  id: number;
  thread_id: number;
  author: string;
  kind: string;
  body: string;
  reply_to_id: number | null;
  created_at: string;
}

export function listDiffFeedbackThreads(
  issueId: number,
  status: "open" | "resolved" | "all",
): DiffFeedbackThreadRow[] {
  return db
    .query(
      `SELECT * FROM diff_feedback_threads
       WHERE issue_id = ? AND (? = 'all' OR status = ?)
       ORDER BY created_at ASC, id ASC`,
    )
    .all(issueId, status, status) as DiffFeedbackThreadRow[];
}

export function getDiffFeedbackThread(
  id: number,
): DiffFeedbackThreadRow | null {
  return (
    (db.query("SELECT * FROM diff_feedback_threads WHERE id = ?").get(id) as
      | DiffFeedbackThreadRow
      | undefined) ?? null
  );
}

export function createDiffFeedbackThread(input: {
  issueId: number;
  prNumber: number;
  baseSha: string;
  headSha: string;
  path: string;
  originalPath: string | null;
  side: string;
  startLine: number;
  endLine: number;
  actor: string;
}): DiffFeedbackThreadRow {
  return db
    .query(
      `INSERT INTO diff_feedback_threads
       (issue_id, pr_number, base_sha, head_sha, path, original_path, side,
        start_line, end_line, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) RETURNING *`,
    )
    .get(
      input.issueId,
      input.prNumber,
      input.baseSha,
      input.headSha,
      input.path,
      input.originalPath,
      input.side,
      input.startLine,
      input.endLine,
      input.actor,
      now(),
    ) as DiffFeedbackThreadRow;
}

export function listDiffFeedbackMessages(
  threadId: number,
): DiffFeedbackMessageRow[] {
  return db
    .query(
      `SELECT * FROM diff_feedback_messages
       WHERE thread_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(threadId) as DiffFeedbackMessageRow[];
}

export function getDiffFeedbackMessage(
  id: number,
): DiffFeedbackMessageRow | null {
  return (
    (db.query("SELECT * FROM diff_feedback_messages WHERE id = ?").get(id) as
      | DiffFeedbackMessageRow
      | undefined) ?? null
  );
}

export function createDiffFeedbackMessage(
  threadId: number,
  author: string,
  kind: string,
  body: string,
  replyToId: number | null = null,
): DiffFeedbackMessageRow {
  return db
    .query(
      `INSERT INTO diff_feedback_messages
       (thread_id, author, kind, body, reply_to_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      threadId,
      author,
      kind,
      body,
      replyToId,
      now(),
    ) as DiffFeedbackMessageRow;
}

export function setDiffFeedbackThreadStatus(
  id: number,
  status: "open" | "resolved",
  actor: string,
): DiffFeedbackThreadRow {
  const resolved = status === "resolved";
  return db
    .query(
      `UPDATE diff_feedback_threads
       SET status = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ? RETURNING *`,
    )
    .get(
      status,
      resolved ? actor : null,
      resolved ? now() : null,
      id,
    ) as DiffFeedbackThreadRow;
}
