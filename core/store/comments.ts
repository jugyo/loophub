import { db, now } from "../db.ts";

// ---- comments ----
export function listComments(issueId: number): any[] {
  return db
    .query(`SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC`)
    .all(issueId);
}
export function createComment(
  issueId: number,
  author: string,
  body: string,
): any {
  const t = now();
  return db
    .query(
      `INSERT INTO comments (issue_id, author, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(issueId, author, body, t, t);
}
export function countComments(issueId: number): number {
  return (
    db
      .query(`SELECT COUNT(*) AS c FROM comments WHERE issue_id = ?`)
      .get(issueId) as any
  ).c;
}
