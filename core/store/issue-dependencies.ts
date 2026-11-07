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
