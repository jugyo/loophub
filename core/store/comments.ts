import { db, now } from "../db.ts";

export type CommentAuthorType = "human" | "agent" | "system";

export interface CommentRow {
  id: number;
  issue_id: number;
  author: string;
  author_type: CommentAuthorType;
  body: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface CommentReactionRow {
  id: number;
  comment_id: number;
  author: string;
  emoji: string;
  created_at: string;
}

// ---- comments ----
/**
 * An issue's or PR's comments, oldest first. Archived comments are part of the record and are
 * returned by default — the caller that wants only the live ones (a CLI listing, an agent reading
 * an issue) asks for them with `includeArchived: false`.
 */
export function listComments(
  issueId: number,
  opts: { includeArchived?: boolean } = {},
): CommentRow[] {
  const onlyLive = opts.includeArchived === false;
  return db
    .query(
      `SELECT * FROM comments
       WHERE issue_id = ?${onlyLive ? " AND archived_at IS NULL" : ""}
       ORDER BY created_at ASC`,
    )
    .all(issueId) as CommentRow[];
}
export function getComment(id: number): CommentRow | null {
  return (
    (db.query("SELECT * FROM comments WHERE id = ?").get(id) as
      | CommentRow
      | undefined) ?? null
  );
}
export function createComment(
  issueId: number,
  author: string,
  body: string,
  authorType: CommentAuthorType = "system",
): CommentRow {
  const t = now();
  return db
    .query(
      `INSERT INTO comments
       (issue_id, author, author_type, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(issueId, author, authorType, body, t, t) as CommentRow;
}
export function setCommentArchived(id: number, archived: boolean): CommentRow {
  return db
    .query(`UPDATE comments SET archived_at = ? WHERE id = ? RETURNING *`)
    .get(archived ? now() : null, id) as CommentRow;
}
export function countComments(issueId: number): number {
  return (
    db
      .query(`SELECT COUNT(*) AS c FROM comments WHERE issue_id = ?`)
      .get(issueId) as { c: number }
  ).c;
}

export function commentCountsByIssue(issueIds: number[]): Map<number, number> {
  if (issueIds.length === 0) return new Map();
  const placeholders = issueIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT issue_id, COUNT(*) AS count
       FROM comments
       WHERE issue_id IN (${placeholders})
       GROUP BY issue_id`,
    )
    .all(...issueIds) as { issue_id: number; count: number }[];
  return new Map(rows.map((row) => [row.issue_id, row.count]));
}

export function listCommentReactions(commentId: number): CommentReactionRow[] {
  return db
    .query(
      `SELECT * FROM comment_reactions
       WHERE comment_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(commentId) as CommentReactionRow[];
}

export function commentReactionsByIssue(
  issueId: number,
): Map<number, CommentReactionRow[]> {
  const rows = db
    .query(
      `SELECT cr.*
       FROM comment_reactions cr
       JOIN comments c ON c.id = cr.comment_id
       WHERE c.issue_id = ?
       ORDER BY cr.created_at ASC, cr.id ASC`,
    )
    .all(issueId) as CommentReactionRow[];
  const byComment = new Map<number, CommentReactionRow[]>();
  for (const row of rows) {
    const reactions = byComment.get(row.comment_id) ?? [];
    reactions.push(row);
    byComment.set(row.comment_id, reactions);
  }
  return byComment;
}

export function setCommentReaction(
  commentId: number,
  author: string,
  emoji: string,
): void {
  const existing = db
    .query(
      `SELECT * FROM comment_reactions
       WHERE comment_id = ? AND author = ?`,
    )
    .get(commentId, author) as CommentReactionRow | undefined;
  if (existing?.emoji === emoji) {
    db.query(
      "DELETE FROM comment_reactions WHERE comment_id = ? AND author = ?",
    ).run(commentId, author);
    return;
  }
  db.query(
    `INSERT INTO comment_reactions
     (comment_id, author, emoji, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (comment_id, author) DO UPDATE SET
       emoji = excluded.emoji,
       created_at = excluded.created_at`,
  ).run(commentId, author, emoji, now());
}
