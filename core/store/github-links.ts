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
  // #848: the loophub head SHA last pushed to the GitHub branch, or null if never pushed from here.
  pushed_sha: string | null;
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

export interface WorkflowGithubPullSyncRow extends GithubPullSyncRow {
  workflow_run_id: number;
  parent_session_id: string;
}

// GitHub feedback is relevant only while an open LoopHub PR's latest running Workflow run has a
// parent session to observe the projected Workflow event. Without a parent_session_id the
// projection has no consumer on the parent contract's event cursor.
export function activeWorkflowGithubPullLinks(): WorkflowGithubPullSyncRow[] {
  return db
    .query(
      `SELECT gp.issue_id AS issue_id, i.repo_id AS repo_id, i.number AS number,
              gp.number AS github_number, gp.url AS url, r.local_path AS local_path,
              wr.id AS workflow_run_id, wr.parent_session_id AS parent_session_id
       FROM github_pulls gp
       JOIN issues i ON i.id = gp.issue_id
       JOIN pulls p ON p.issue_id = gp.issue_id
       JOIN repos r ON r.id = i.repo_id
       JOIN workflow_runs wr ON wr.id = (
         SELECT candidate.id FROM workflow_runs candidate
         WHERE candidate.repo_id = i.repo_id AND candidate.pr_number = i.number
           AND candidate.status = 'running'
         ORDER BY candidate.id DESC LIMIT 1
       )
       WHERE i.kind = 'pull' AND i.state = 'open' AND p.merged = 0
         AND p.archived_at IS NULL AND r.archived = 0
         AND wr.parent_session_id IS NOT NULL
       ORDER BY i.repo_id, i.number`,
    )
    .all() as WorkflowGithubPullSyncRow[];
}

export interface GithubFeedbackObservation {
  issue_id: number;
  kind: "issue_comment" | "review" | "review_comment";
  github_id: number;
  content_hash: string;
  updated_at: string;
  observed_at: string;
}

export function getGithubFeedbackObservation(
  issueId: number,
  kind: GithubFeedbackObservation["kind"],
  githubId: number,
): GithubFeedbackObservation | null {
  return (
    (db
      .query(
        `SELECT * FROM github_pull_feedback
         WHERE issue_id = ? AND kind = ? AND github_id = ?`,
      )
      .get(issueId, kind, githubId) as GithubFeedbackObservation | null) ?? null
  );
}

// Every GitHub feedback item observed on one PR, so a reader can compare the whole set's revisions
// in one read instead of asking per item. Ordered by identity rather than observation time: the
// order must not change when a single item is re-observed.
export function listGithubFeedbackObservations(
  issueId: number,
): GithubFeedbackObservation[] {
  return db
    .query(
      `SELECT * FROM github_pull_feedback
       WHERE issue_id = ?
       ORDER BY kind ASC, github_id ASC`,
    )
    .all(issueId) as GithubFeedbackObservation[];
}

export function saveGithubFeedbackObservation(input: {
  issueId: number;
  kind: GithubFeedbackObservation["kind"];
  githubId: number;
  contentHash: string;
  updatedAt: string;
}): GithubFeedbackObservation {
  return db
    .query(
      `INSERT INTO github_pull_feedback
         (issue_id, kind, github_id, content_hash, updated_at, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, kind, github_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at,
         observed_at = excluded.observed_at
       RETURNING *`,
    )
    .get(
      input.issueId,
      input.kind,
      input.githubId,
      input.contentHash,
      input.updatedAt,
      now(),
    ) as GithubFeedbackObservation;
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
         AND p.merged = 0 AND p.archived_at IS NULL AND r.archived = 0`,
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

// #848: record the loophub head SHA just pushed to the GitHub branch, so a later diff against the
// PR's live head reveals whether local commits added after the export are still unpushed. Idempotent
// — re-pushing the same head re-sets the same value. Requires an existing link (caller guards).
export function setGithubPushed(issueId: number, sha: string): GithubPull {
  return db
    .query(
      `UPDATE github_pulls SET pushed_sha = ? WHERE issue_id = ? RETURNING *`,
    )
    .get(sha, issueId) as GithubPull;
}

// #850: cached GitHub-side status for a PR's linked GitHub PR (the payload is core/github.ts
// GhPrStatus as JSON; synced_at is when it was fetched).
export interface GithubPullStatusCache {
  issue_id: number;
  payload: string;
  synced_at: string;
}

// #850: read the cached GitHub PR status for a loophub PR, or null when never fetched.
export function getGithubPullStatus(
  issueId: number,
): GithubPullStatusCache | null {
  return (
    (db
      .query(`SELECT * FROM github_pull_status WHERE issue_id = ?`)
      .get(issueId) as GithubPullStatusCache) ?? null
  );
}

// #850: upsert the cached GitHub PR status. synced_at is stamped now() on every write so the service
// can TTL against it; idempotent on issue_id (a re-fetch overwrites the previous snapshot).
export function saveGithubPullStatus(
  issueId: number,
  payload: string,
): GithubPullStatusCache {
  return db
    .query(
      `INSERT INTO github_pull_status (issue_id, payload, synced_at)
       VALUES (?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET
         payload = excluded.payload,
         synced_at = excluded.synced_at
       RETURNING *`,
    )
    .get(issueId, payload, now()) as GithubPullStatusCache;
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
