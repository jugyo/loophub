import { db, now } from "../db.ts";

/**
 * One "viewed" toggle of one changed file (#2502). Rows are only ever appended: unmarking a file
 * appends a `viewed = 0` row rather than deleting the earlier one, so the history of how far a
 * reader had got stays readable, and the newest row for a path is the current state.
 */
export interface PullFileViewRow {
  id: number;
  issue_id: number;
  path: string;
  /** The file's newest PR commit when the row was written; NULL when the walk named none. */
  sha: string | null;
  viewed: number;
  created_at: string;
}

export function addPullFileView(
  issueId: number,
  path: string,
  sha: string | null,
  viewed: boolean,
): PullFileViewRow {
  return db
    .query(
      `INSERT INTO pull_file_views (issue_id, path, sha, viewed, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(issueId, path, sha, viewed ? 1 : 0, now()) as PullFileViewRow;
}

/**
 * The newest row for each path of one PR, oldest path first. Callers read the current state from
 * these; the rows they supersede stay in the table as the record of earlier passes.
 */
export function latestPullFileViews(issueId: number): PullFileViewRow[] {
  return db
    .query(
      `SELECT views.* FROM pull_file_views AS views
       JOIN (
         SELECT path, MAX(id) AS id FROM pull_file_views
         WHERE issue_id = ? GROUP BY path
       ) AS latest ON latest.id = views.id
       ORDER BY views.id ASC`,
    )
    .all(issueId) as PullFileViewRow[];
}

/** Every row for one PR, oldest first — the append-only history behind the state above. */
export function listPullFileViews(issueId: number): PullFileViewRow[] {
  return db
    .query(`SELECT * FROM pull_file_views WHERE issue_id = ? ORDER BY id ASC`)
    .all(issueId) as PullFileViewRow[];
}
