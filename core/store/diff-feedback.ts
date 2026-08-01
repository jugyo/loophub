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

export interface DiffFeedbackLocationRow {
  thread_id: number;
  base_sha: string;
  head_sha: string;
  resolved_anchor_json: string | null;
  freshness: string;
  outdated_reason: string | null;
  placement: string;
  original_context_json: string | null;
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

export function listUnansweredDiffFeedbackThreads(
  issueId: number,
  responders: readonly string[],
): DiffFeedbackThreadRow[] {
  const responderClause =
    responders.length === 0
      ? ""
      : `AND (latest.author IS NULL OR latest.author NOT IN (${responders
          .map(() => "?")
          .join(", ")}))`;
  return db
    .query(
      `SELECT thread.*
       FROM diff_feedback_threads thread
       LEFT JOIN diff_feedback_messages latest
         ON latest.id = (
           SELECT message.id
           FROM diff_feedback_messages message
           WHERE message.thread_id = thread.id
           ORDER BY message.created_at DESC, message.id DESC
           LIMIT 1
         )
       WHERE thread.issue_id = ?
         AND thread.resolved_at IS NULL
         ${responderClause}
       ORDER BY thread.created_at ASC, thread.id ASC`,
    )
    .all(issueId, ...responders) as DiffFeedbackThreadRow[];
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

export function listDiffFeedbackLocations(
  issueId: number,
  baseSha: string,
  headSha: string,
): DiffFeedbackLocationRow[] {
  return db
    .query(
      `SELECT location.*
       FROM diff_feedback_locations location
       INNER JOIN diff_feedback_threads thread ON thread.id = location.thread_id
       WHERE thread.issue_id = ? AND location.base_sha = ? AND location.head_sha = ?`,
    )
    .all(issueId, baseSha, headSha) as DiffFeedbackLocationRow[];
}

export function upsertDiffFeedbackLocation(row: DiffFeedbackLocationRow): void {
  db.query(
    `INSERT INTO diff_feedback_locations
       (thread_id, base_sha, head_sha, resolved_anchor_json, freshness,
        outdated_reason, placement, original_context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (thread_id, base_sha, head_sha) DO UPDATE SET
       resolved_anchor_json = excluded.resolved_anchor_json,
       freshness = excluded.freshness,
       outdated_reason = excluded.outdated_reason,
       placement = excluded.placement,
       original_context_json = excluded.original_context_json`,
  ).run(
    row.thread_id,
    row.base_sha,
    row.head_sha,
    row.resolved_anchor_json,
    row.freshness,
    row.outdated_reason,
    row.placement,
    row.original_context_json,
  );
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

// Every diff-feedback message on the PR, across all of its threads. Counted in SQL so a list row
// can show the total without loading threads and messages.
export function countDiffFeedbackMessages(issueId: number): number {
  return (
    db
      .query(
        `SELECT COUNT(*) AS c FROM diff_feedback_messages m
         JOIN diff_feedback_threads t ON t.id = m.thread_id
         WHERE t.issue_id = ?`,
      )
      .get(issueId) as { c: number }
  ).c;
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

export function setDiffFeedbackReaction(
  messageId: number,
  author: string,
  emoji: string,
): void {
  const existing = db
    .query(
      `SELECT * FROM diff_feedback_reactions
       WHERE message_id = ? AND author = ?`,
    )
    .get(messageId, author) as DiffFeedbackReactionRow | undefined;
  if (existing?.emoji === emoji) {
    db.query(
      "DELETE FROM diff_feedback_reactions WHERE message_id = ? AND author = ?",
    ).run(messageId, author);
    return;
  }
  db.query(
    `INSERT INTO diff_feedback_reactions
     (message_id, author, emoji, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (message_id, author) DO UPDATE SET
       emoji = excluded.emoji,
       created_at = excluded.created_at`,
  ).run(messageId, author, emoji, now());
}
