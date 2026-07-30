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
  created_by: string;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

export interface DiffFeedbackMessageRow {
  id: number;
  thread_id: number;
  author: string;
  body: string;
  created_at: string;
}

export interface DiffFeedbackReactionRow {
  id: number;
  message_id: number;
  author: string;
  emoji: string;
  created_at: string;
}

export function listDiffFeedbackThreads(
  issueId: number,
): DiffFeedbackThreadRow[] {
  return db
    .query(
      `SELECT * FROM diff_feedback_threads
       WHERE issue_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(issueId) as DiffFeedbackThreadRow[];
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
        start_line, end_line, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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

export function setDiffFeedbackThreadResolved(
  id: number,
  actor: string | null,
): DiffFeedbackThreadRow {
  return db
    .query(
      `UPDATE diff_feedback_threads
       SET resolved_by = ?, resolved_at = ?
       WHERE id = ?
       RETURNING *`,
    )
    .get(actor, actor ? now() : null, id) as DiffFeedbackThreadRow;
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
  body: string,
): DiffFeedbackMessageRow {
  return db
    .query(
      `INSERT INTO diff_feedback_messages
       (thread_id, author, body, created_at)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(threadId, author, body, now()) as DiffFeedbackMessageRow;
}

export function listDiffFeedbackReactions(
  messageId: number,
): DiffFeedbackReactionRow[] {
  return db
    .query(
      `SELECT * FROM diff_feedback_reactions
       WHERE message_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(messageId) as DiffFeedbackReactionRow[];
}

export function createDiffFeedbackReaction(
  messageId: number,
  author: string,
  emoji: string,
): DiffFeedbackReactionRow {
  db.query(
    `INSERT OR IGNORE INTO diff_feedback_reactions
     (message_id, author, emoji, created_at) VALUES (?, ?, ?, ?)`,
  ).run(messageId, author, emoji, now());
  return db
    .query(
      `SELECT * FROM diff_feedback_reactions
       WHERE message_id = ? AND author = ? AND emoji = ?`,
    )
    .get(messageId, author, emoji) as DiffFeedbackReactionRow;
}
