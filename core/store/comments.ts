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

// ---- comments ----
export function listComments(issueId: number): CommentRow[] {
  return db
    .query(`SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC`)
    .all(issueId) as CommentRow[];
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
