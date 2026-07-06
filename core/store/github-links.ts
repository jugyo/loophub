import { db, now } from "../db.ts";

export interface GithubPull {
  issue_id: number;
  number: number;
  url: string;
  branch: string | null;
  created_by: string | null;
  created_at: string;
  github_merged: number;
  github_merged_at: string | null;
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

// #800: a github_pulls row not yet known to be merged on GitHub, joined with enough to run the
// merge-status check and record the result — the loophub PR number (for the event payload), the
// repo id (to emit into), and local_path (gh's cwd; the URL itself carries owner/repo/number so
// gh resolves the right PR regardless of local_path's own remote).
export interface GithubPullSyncRow {
  issue_id: number;
  repo_id: number;
  number: number;
  github_number: number;
  url: string;
  local_path: string;
}

// #800: github_pulls links still worth polling — has a GitHub link, not yet github_merged, and the
// loophub side is still open/unmerged (the scenario this issue targets: exported-then-merged-on-
// GitHub while the loophub PR itself hasn't gone through its own merge flow yet). Once the loophub
// PR is closed/merged locally or github_merged flips on, it drops out here so lh-worker doesn't
// poll `gh` forever for a link nobody cares about anymore. Archived repos are excluded, mirroring
// S.openPulls' sweep-target filter.
export function unmergedGithubPullLinks(): GithubPullSyncRow[] {
  return db
    .query(
      `SELECT gp.issue_id AS issue_id, i.repo_id AS repo_id, i.number AS number,
              gp.number AS github_number, gp.url AS url, r.local_path AS local_path
       FROM github_pulls gp
       JOIN issues i ON i.id = gp.issue_id
       JOIN pulls p ON p.issue_id = gp.issue_id
       JOIN repos r ON r.id = i.repo_id
       WHERE gp.github_merged = 0 AND i.kind = 'pull' AND i.state = 'open'
         AND p.merged = 0 AND r.archived = 0`,
    )
    .all() as GithubPullSyncRow[];
}

// #800: record that the GitHub PR has been merged (idempotent — re-running after it's already
// flagged just re-sets the same values, since unmergedGithubPullLinks stops returning the row).
export function setGithubMerged(issueId: number, mergedAt: string): GithubPull {
  return db
    .query(
      `UPDATE github_pulls SET github_merged = 1, github_merged_at = ?
       WHERE issue_id = ? RETURNING *`,
    )
    .get(mergedAt, issueId) as GithubPull;
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
