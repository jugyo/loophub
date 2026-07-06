import { db } from "../db.ts";

// ---- labels ----
export function ensureLabel(repoId: number, name: string): any {
  let l = db
    .query(`SELECT * FROM labels WHERE repo_id = ? AND name = ?`)
    .get(repoId, name);
  if (!l)
    l = db
      .query(`INSERT INTO labels (repo_id, name) VALUES (?, ?) RETURNING *`)
      .get(repoId, name);
  return l;
}
export function listLabels(repoId: number): any[] {
  return db
    .query(`SELECT * FROM labels WHERE repo_id = ? ORDER BY name`)
    .all(repoId);
}
export function issueLabels(issueId: number): any[] {
  return db
    .query(
      `SELECT l.* FROM labels l JOIN issue_labels il ON il.label_id = l.id
       WHERE il.issue_id = ? ORDER BY l.name`,
    )
    .all(issueId);
}
export function addLabels(repoId: number, issueId: number, names: string[]) {
  for (const n of names) {
    const l = ensureLabel(repoId, n) as any;
    db.run(
      `INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)`,
      [issueId, l.id],
    );
  }
}
export function setLabels(repoId: number, issueId: number, names: string[]) {
  db.run(`DELETE FROM issue_labels WHERE issue_id = ?`, [issueId]);
  addLabels(repoId, issueId, names);
}
export function removeLabel(repoId: number, issueId: number, name: string) {
  const l = db
    .query(`SELECT id FROM labels WHERE repo_id = ? AND name = ?`)
    .get(repoId, name) as any;
  if (l)
    db.run(`DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?`, [
      issueId,
      l.id,
    ]);
}
