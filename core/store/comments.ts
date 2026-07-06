import { db, now } from "../db.ts";

export interface CommentRow {
  id: number;
  issue_id: number;
  author: string;
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
): CommentRow {
  const t = now();
  return db
    .query(
      `INSERT INTO comments (issue_id, author, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(issueId, author, body, t, t) as CommentRow;
}
export function countComments(issueId: number): number {
  return (
    db
      .query(`SELECT COUNT(*) AS c FROM comments WHERE issue_id = ?`)
      .get(issueId) as { c: number }
  ).c;
}
