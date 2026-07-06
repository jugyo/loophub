import { db, now } from "../db.ts";

export interface GithubPull {
  issue_id: number;
  number: number;
  url: string;
  branch: string | null;
  created_by: string | null;
  created_at: string;
}

export interface GithubIssue {
  issue_id: number;
  owner: string;
  repo: string;
  number: number;
  url: string;
  created_by: string | null;
  created_at: string;
}

// ---- github links ----
// #406: the GitHub PR a loophub PR was exported to, or null. Keyed by the PR's issues row id.
export function getGithubPull(issueId: number): GithubPull | null {
  return (
    (db
      .query(`SELECT * FROM github_pulls WHERE issue_id = ?`)
      .get(issueId) as GithubPull) ?? null
  );
}

// #406: record (or replace) the GitHub PR for a loophub PR. Idempotent on issue_id — re-recording
// overwrites, so a re-run of the export skill updates the link rather than erroring. created_at is
// preserved on overwrite (the link's first-seen time) while the rest is refreshed.
export function recordGithubPull(input: {
  issueId: number;
  number: number;
  url: string;
  branch?: string | null;
  createdBy?: string | null;
}): GithubPull {
  const { issueId, number, url, branch, createdBy } = input;
  return db
    .query(
      `INSERT INTO github_pulls (issue_id, number, url, branch, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET
         number = excluded.number,
         url = excluded.url,
         branch = excluded.branch,
         created_by = excluded.created_by
       RETURNING *`,
    )
    .get(
      issueId,
      number,
      url,
      branch ?? null,
      createdBy ?? null,
      now(),
    ) as GithubPull;
}

// #614: the GitHub issue a loophub issue was imported from, or null.
export function getGithubIssue(issueId: number): GithubIssue | null {
  return (
    (db
      .query(`SELECT * FROM github_issues WHERE issue_id = ?`)
      .get(issueId) as GithubIssue) ?? null
  );
}

// #614: record the GitHub source of an imported loophub issue. Unlike recordGithubPull this is a
// plain INSERT (no ON CONFLICT): each import creates a fresh loophub issue, so issue_id is always new.
export function recordGithubIssue(input: {
  issueId: number;
  owner: string;
  repo: string;
  number: number;
  url: string;
  createdBy?: string | null;
}): GithubIssue {
  const { issueId, owner, repo, number, url, createdBy } = input;
  return db
    .query(
      `INSERT INTO github_issues (issue_id, owner, repo, number, url, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      issueId,
      owner,
      repo,
      number,
      url,
      createdBy ?? null,
      now(),
    ) as GithubIssue;
}

// #614: every loophub issue imported from a given GitHub issue (many-to-one). Backs the AC that one
// GitHub issue can carry multiple loophub imports; resolved via idx_github_issues_source.
export function loophubIssuesForGithubIssue(
  owner: string,
  repo: string,
  number: number,
): GithubIssue[] {
  return db
    .query(
      `SELECT * FROM github_issues WHERE owner = ? AND repo = ? AND number = ? ORDER BY issue_id`,
    )
    .all(owner, repo, number) as GithubIssue[];
}
