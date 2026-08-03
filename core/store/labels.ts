import { db } from "../db.ts";

export interface LabelRow {
  id: number;
  repo_id: number;
  name: string;
  color: string | null;
}

// ---- labels ----
export function ensureLabel(repoId: number, name: string): LabelRow {
  let l = db
    .query(`SELECT * FROM labels WHERE repo_id = ? AND name = ?`)
    .get(repoId, name) as LabelRow | null;
  if (!l)
    l = db
      .query(`INSERT INTO labels (repo_id, name) VALUES (?, ?) RETURNING *`)
      .get(repoId, name) as LabelRow;
  return l;
}
export function listLabels(repoId: number): LabelRow[] {
  return db
    .query(`SELECT * FROM labels WHERE repo_id = ? ORDER BY name`)
    .all(repoId) as LabelRow[];
}
export function issueLabels(issueId: number): LabelRow[] {
  return db
    .query(
      `SELECT l.* FROM labels l JOIN issue_labels il ON il.label_id = l.id
       WHERE il.issue_id = ? ORDER BY l.name`,
    )
    .all(issueId) as LabelRow[];
}

export function labelsByIssue(issueIds: number[]): Map<number, LabelRow[]> {
  if (issueIds.length === 0) return new Map();
  const placeholders = issueIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT il.issue_id, l.*
       FROM issue_labels il
       JOIN labels l ON l.id = il.label_id
       WHERE il.issue_id IN (${placeholders})
       ORDER BY il.issue_id, l.name`,
    )
    .all(...issueIds) as (LabelRow & { issue_id: number })[];
  const byIssue = new Map<number, LabelRow[]>();
  for (const row of rows) {
    const labels = byIssue.get(row.issue_id) ?? [];
    labels.push(row);
    byIssue.set(row.issue_id, labels);
  }
  return byIssue;
}

export function issueIdsWithLabels(
  repoId: number,
  names: string[],
): Set<number> {
  if (names.length === 0) return new Set();
  const placeholders = names.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT il.issue_id
       FROM issue_labels il
       JOIN labels l ON l.id = il.label_id
       WHERE l.repo_id = ? AND l.name IN (${placeholders})
       GROUP BY il.issue_id
       HAVING COUNT(DISTINCT l.name) = ?`,
    )
    .all(repoId, ...names, new Set(names).size) as { issue_id: number }[];
  return new Set(rows.map((row) => row.issue_id));
}
export function addLabels(repoId: number, issueId: number, names: string[]) {
  for (const n of names) {
    const l = ensureLabel(repoId, n);
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
