import { db, now } from "../db.ts";
import type { IssueRow } from "./issues.ts";

export interface IssueGroupRow {
  id: number;
  repo_id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

// ---- issue groups (#312) ----
// A group is a repo-scoped, ordered collection of issues, stored entirely apart from the issues
// table (see db.ts). Membership is many-to-many via issue_group_members with a per-group `position`
// for ordering; an issue may belong to several groups. All functions here are pure store access —
// validation/event emission lives in service.ts.
export function createIssueGroup(repoId: number, name: string): IssueGroupRow {
  const t = now();
  return db
    .query(
      `INSERT INTO issue_groups (repo_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(repoId, name, t, t) as IssueGroupRow;
}

export function getIssueGroupById(id: number): IssueGroupRow | null {
  return db
    .query(`SELECT * FROM issue_groups WHERE id = ?`)
    .get(id) as IssueGroupRow | null;
}

export function getIssueGroupByName(
  repoId: number,
  name: string,
): IssueGroupRow | null {
  return db
    .query(`SELECT * FROM issue_groups WHERE repo_id = ? AND name = ?`)
    .get(repoId, name) as IssueGroupRow | null;
}

export function listIssueGroups(repoId: number): IssueGroupRow[] {
  return db
    .query(`SELECT * FROM issue_groups WHERE repo_id = ? ORDER BY name`)
    .all(repoId) as IssueGroupRow[];
}

export function renameIssueGroup(
  id: number,
  name: string,
): IssueGroupRow | null {
  db.run(`UPDATE issue_groups SET name = ?, updated_at = ? WHERE id = ?`, [
    name,
    now(),
    id,
  ]);
  return getIssueGroupById(id);
}

export function deleteIssueGroup(id: number): void {
  db.run(`DELETE FROM issue_group_members WHERE group_id = ?`, [id]);
  db.run(`DELETE FROM issue_groups WHERE id = ?`, [id]);
}

// Count members so a group summary can report size without listing rows.
export function countGroupMembers(groupId: number): number {
  return (
    db
      .query(`SELECT COUNT(*) AS c FROM issue_group_members WHERE group_id = ?`)
      .get(groupId) as { c: number }
  ).c;
}

// Add an issue at the end of the group's order (idempotent: re-adding an existing member is a
// no-op that keeps its current position). Returns true when a new membership was created.
export function addIssueToGroup(groupId: number, issueId: number): boolean {
  const existing = db
    .query(
      `SELECT 1 FROM issue_group_members WHERE group_id = ? AND issue_id = ?`,
    )
    .get(groupId, issueId);
  if (existing) return false;
  const next = db
    .query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS p FROM issue_group_members WHERE group_id = ?`,
    )
    .get(groupId) as { p: number };
  db.run(
    `INSERT INTO issue_group_members (group_id, issue_id, position, added_at)
     VALUES (?, ?, ?, ?)`,
    [groupId, issueId, next.p, now()],
  );
  db.run(`UPDATE issue_groups SET updated_at = ? WHERE id = ?`, [
    now(),
    groupId,
  ]);
  return true;
}

// Remove an issue from a group. Returns true when a membership was actually removed. Remaining
// members keep their positions (gaps are fine — order is defined by position, not contiguity).
export function removeIssueFromGroup(
  groupId: number,
  issueId: number,
): boolean {
  const existing = db
    .query(
      `SELECT 1 FROM issue_group_members WHERE group_id = ? AND issue_id = ?`,
    )
    .get(groupId, issueId);
  if (!existing) return false;
  db.run(
    `DELETE FROM issue_group_members WHERE group_id = ? AND issue_id = ?`,
    [groupId, issueId],
  );
  db.run(`UPDATE issue_groups SET updated_at = ? WHERE id = ?`, [
    now(),
    groupId,
  ]);
  return true;
}

// Issues in a group, ordered by position (insertion order). Returns full issue rows.
export function listGroupMembers(groupId: number): IssueRow[] {
  return db
    .query(
      `SELECT i.* FROM issues i
       JOIN issue_group_members m ON m.issue_id = i.id
       WHERE m.group_id = ?
       ORDER BY m.position`,
    )
    .all(groupId) as IssueRow[];
}

// Reverse of membership: the groups an issue belongs to, ordered by name (mirrors listIssueGroups).
// Membership is many-to-many, so an issue can belong to several groups. Powers the "other issues in
// the same group" list on the issue detail view (#314).
export function listGroupsForIssue(issueId: number): IssueGroupRow[] {
  return db
    .query(
      `SELECT g.* FROM issue_groups g
       JOIN issue_group_members m ON m.group_id = g.id
       WHERE m.issue_id = ?
       ORDER BY g.name`,
    )
    .all(issueId) as IssueGroupRow[];
}
