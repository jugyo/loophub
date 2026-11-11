import { db, now } from "../db.ts";
import type { IssueRow } from "./issues.ts";

// #2644: "blocked by" edges between issues of one repo, separate from the sub-issue hierarchy.

export function addIssueDependency(issueId: number, blockerIssueId: number) {
  db.run(
    `INSERT OR IGNORE INTO issue_dependencies (issue_id, blocker_issue_id, created_at)
     VALUES (?, ?, ?)`,
    [issueId, blockerIssueId, now()],
  );
}

export function removeIssueDependency(issueId: number, blockerIssueId: number) {
  db.run(
    `DELETE FROM issue_dependencies WHERE issue_id = ? AND blocker_issue_id = ?`,
    [issueId, blockerIssueId],
  );
}

/** The issues `issueId` is blocked by, in number order. */
export function listIssueBlockers(issueId: number): IssueRow[] {
  return db
    .query(
      `SELECT i.* FROM issue_dependencies d
       JOIN issues i ON i.id = d.blocker_issue_id
       WHERE d.issue_id = ? ORDER BY i.number`,
    )
    .all(issueId) as IssueRow[];
}

/** The issues blocked by `blockerIssueId`, in number order. */
export function listIssueDependents(blockerIssueId: number): IssueRow[] {
  return db
    .query(
      `SELECT i.* FROM issue_dependencies d
       JOIN issues i ON i.id = d.issue_id
       WHERE d.blocker_issue_id = ? ORDER BY i.number`,
    )
    .all(blockerIssueId) as IssueRow[];
}

function dependencyRowsByIssue(
  issueIds: number[],
  keyColumn: "issue_id" | "blocker_issue_id",
  otherColumn: "issue_id" | "blocker_issue_id",
): Map<number, IssueRow[]> {
  const out = new Map<number, IssueRow[]>();
  if (issueIds.length === 0) return out;
  const placeholders = issueIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT d.${keyColumn} AS dependency_key, i.* FROM issue_dependencies d
       JOIN issues i ON i.id = d.${otherColumn}
       WHERE d.${keyColumn} IN (${placeholders}) ORDER BY i.number`,
    )
    .all(...issueIds) as (IssueRow & { dependency_key: number })[];
  for (const { dependency_key, ...row } of rows) {
    const list = out.get(dependency_key) ?? [];
    list.push(row);
    out.set(dependency_key, list);
  }
  return out;
}

/** {@link listIssueBlockers} for many issues at once, keyed by issue id. */
export function issueBlockersByIssue(
  issueIds: number[],
): Map<number, IssueRow[]> {
  return dependencyRowsByIssue(issueIds, "issue_id", "blocker_issue_id");
}

/** {@link listIssueDependents} for many issues at once, keyed by blocker issue id. */
export function issueDependentsByIssue(
  issueIds: number[],
): Map<number, IssueRow[]> {
  return dependencyRowsByIssue(issueIds, "blocker_issue_id", "issue_id");
}
