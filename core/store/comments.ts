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
}

export interface CommentReactionRow {
  id: number;
  comment_id: number;
  author: string;
  emoji: string;
  created_at: string;
}

// ---- comments ----
export function listComments(issueId: number): CommentRow[] {
  return db
    .query(`SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC`)
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
export function countComments(issueId: number): number {
  return (
    db
      .query(`SELECT COUNT(*) AS c FROM comments WHERE issue_id = ?`)
      .get(issueId) as { c: number }
  ).c;
}

export function listCommentReactions(commentId: number): CommentReactionRow[] {
  return db
    .query(
      `SELECT * FROM comment_reactions
       WHERE comment_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(commentId) as CommentReactionRow[];
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
