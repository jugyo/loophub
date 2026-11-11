import { db, now } from "../db.ts";

// #2383: a loophub PR's GitHub export, whatever stage it is at — one row carrying both the GitHub
// PR and how far the export got. `status` is the lifecycle ('creating' -> 'linked'; unlinking
// deletes the row). Modelled as a union on that status so the link columns are only reachable on the
// stage that has them, which mirrors the table's own CHECK: a reader that has a linked export never
// has to consider a half-filled link, and one holding an export in flight cannot read a GitHub PR
// number out of it.
interface GithubPrExportFields {
  issue_id: number;
  branch: string | null;
  created_by: string | null;
  // When the export began — the launch for a row opened by the Create action, or the recording
  // itself for a link recorded without one.
  created_at: string;
  github_merged: number;
  github_merged_at: string | null;
  // #848: the loophub head SHA last pushed to the GitHub branch, or null if never pushed from here.
  pushed_sha: string | null;
}

/** An export whose agent has not recorded a GitHub PR yet. */
export interface GithubPrExportCreating extends GithubPrExportFields {
  status: "creating";
  number: null;
  url: null;
  linked_at: null;
}

/** A GitHub export that reached 'linked' — the recorded GitHub PR. */
export interface GithubPull extends GithubPrExportFields {
  status: "linked";
  number: number;
  url: string;
  linked_at: string;
}

export type GithubPrExport = GithubPrExportCreating | GithubPull;

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
// #2383: a loophub PR's GitHub export at whatever stage it is at, or null when it has none. This is
// the whole model — "is an export running?" and "which GitHub PR is linked?" are both answered from
// this one row, so the two can never disagree.
export function getGithubPrExport(issueId: number): GithubPrExport | null {
  return (
    (db
      .query(`SELECT * FROM github_pulls WHERE issue_id = ?`)
      .get(issueId) as GithubPrExport) ?? null
  );
}

// #406: the GitHub PR a loophub PR was exported to, or null. Keyed by the PR's issues row id. An
// export still in flight is deliberately *not* a link: it identifies no GitHub PR yet, so every
// caller asking "does this PR have a GitHub PR?" — the double-create guard, the push controls, the
// status panel — reads null until one exists.
export function getGithubPull(issueId: number): GithubPull | null {
  return (
    (db
      .query(
        `SELECT * FROM github_pulls WHERE issue_id = ? AND status = 'linked'`,
      )
      .get(issueId) as GithubPull) ?? null
  );
}

// #2383: open the export record when the Create action's agent is launched, so "an export is
// running" is persisted rather than inferred. A relaunch restarts the record's clock — the newest
// attempt is the one in flight, and without this a retry after an export that died would inherit
// the dead one's start and read as expired the moment the page reloads. A row that already reached
// 'linked' is a recorded GitHub PR and is left alone: the DO UPDATE's WHERE is what keeps a stray
// launch from reverting a real link to "creating".
export function beginGithubPrExport(input: {
  issueId: number;
  createdBy?: string | null;
}): GithubPrExport {
  db.run(
    `INSERT INTO github_pulls (issue_id, status, created_by, created_at)
     VALUES (?, 'creating', ?, ?)
     ON CONFLICT(issue_id) DO UPDATE SET
       created_by = excluded.created_by,
       created_at = excluded.created_at
     WHERE github_pulls.status = 'creating'`,
    [input.issueId, input.createdBy ?? null, now()],
  );
  return getGithubPrExport(input.issueId) as GithubPrExport;
}

// #406: record (or replace) the GitHub PR for a loophub PR. Idempotent on issue_id — re-recording
// overwrites, so a re-run of the export skill updates the link rather than erroring, and the row a
// launch opened as 'creating' is completed in place. created_at is preserved on overwrite (when the
// export began) while the rest is refreshed; linked_at moves to now because that is when this link
// was recorded.
export function recordGithubPull(input: {
  issueId: number;
  number: number;
  url: string;
  branch?: string | null;
  createdBy?: string | null;
}): GithubPull {
  const { issueId, number, url, branch, createdBy } = input;
  const t = now();
  return db
    .query(
      `INSERT INTO github_pulls
         (issue_id, status, number, url, branch, created_by, created_at, linked_at)
       VALUES (?, 'linked', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET
         status = 'linked',
         number = excluded.number,
         url = excluded.url,
         branch = excluded.branch,
         created_by = excluded.created_by,
         linked_at = excluded.linked_at
       RETURNING *`,
    )
    .get(
      issueId,
      number,
      url,
      branch ?? null,
      createdBy ?? null,
      t,
      t,
    ) as GithubPull;
}

// #2384: drop a loophub PR's GitHub PR link, so a wrong link can be corrected and a GitHub PR can be
// created again. The caller reads the row first (for the event payload and its own guard), so this
// takes no return value. The cached GitHub-side status goes with it: it is a snapshot of a PR that is
// no longer linked, and leaving it would serve a stale panel (within the TTL) for whatever GitHub PR
// is linked next. `pushed_sha` is a column of the deleted row, so it goes too. github_pull_feedback
// is deliberately kept — it is a de-dup ledger of feedback already delivered, keyed by GitHub's own
// comment/review ids, so re-linking the same PR must not replay every comment as new; ids belonging
// to a different GitHub PR never collide with the retained ones.
export function deleteGithubPull(issueId: number): void {
  db.run(`DELETE FROM github_pull_status WHERE issue_id = ?`, [issueId]);
  db.run(`DELETE FROM github_pulls WHERE issue_id = ?`, [issueId]);
}

// One GitHub sync target: an open, active loophub PR linked to a GitHub PR. Joined with enough to
// call `gh` (local_path is gh's cwd; the URL itself carries owner/repo/number) and to record the
// result — the loophub PR number (for event payloads) and the repo id (to emit into).
// `github_merged` tells the merge check to skip a link already known merged. The run columns are set
// only while the PR's latest running Workflow run has a parent session to observe the projected
// feedback event: without a parent_session_id the projection has no consumer on the parent
// contract's event cursor.
export interface GithubSyncRow {
  issue_id: number;
  repo_id: number;
  number: number;
  github_number: number;
  url: string;
  local_path: string;
  github_merged: number;
  workflow_run_id: number | null;
  parent_session_id: string | null;
}

// The single selection of GitHub sync targets. Once the loophub PR is closed/merged locally or
// archived, it drops out here so lh-worker doesn't poll `gh` forever for a link nobody cares about
// anymore. Archived repos are excluded, mirroring S.openPulls' sweep-target filter.
export function githubSyncRows(): GithubSyncRow[] {
  return db
    .query(
      `SELECT gp.issue_id AS issue_id, i.repo_id AS repo_id, i.number AS number,
              gp.number AS github_number, gp.url AS url, r.local_path AS local_path,
              gp.github_merged AS github_merged,
              CASE WHEN wr.parent_session_id IS NOT NULL THEN wr.id END AS workflow_run_id,
              wr.parent_session_id AS parent_session_id
       FROM github_pulls gp
       JOIN issues i ON i.id = gp.issue_id
       JOIN pulls p ON p.issue_id = gp.issue_id
       JOIN repos r ON r.id = i.repo_id
       LEFT JOIN workflow_runs wr ON wr.id = (
         SELECT candidate.id FROM workflow_runs candidate
         WHERE candidate.repo_id = i.repo_id AND candidate.pr_number = i.number
           AND candidate.status = 'running'
         ORDER BY candidate.id DESC LIMIT 1
       )
       WHERE gp.status = 'linked'
         AND i.kind = 'pull' AND i.state = 'open' AND p.merged = 0
         AND p.archived_at IS NULL AND r.archived = 0
       ORDER BY i.repo_id, i.number`,
    )
    .all() as GithubSyncRow[];
}

/** Whether a Workflow run is currently running on this PR, and so would receive a PR comment. */
export function hasRunningWorkflowRun(
  repoId: number,
  prNumber: number,
): boolean {
  return !!db
    .query(
      `SELECT 1 FROM workflow_runs
       WHERE repo_id = ? AND pr_number = ? AND status = 'running' LIMIT 1`,
    )
    .get(repoId, prNumber);
}

export interface GithubFeedbackObservation {
  issue_id: number;
  kind: "issue_comment" | "review" | "review_comment";
  github_id: number;
  content_hash: string;
  updated_at: string;
  observed_at: string;
  // #2500: what the PR timeline renders for this item. Null on a row observed before the columns
  // existed — an unchanged item is never re-observed, so those rows are not backfilled.
  created_at: string | null;
  author_login: string | null;
  review_state: string | null;
  url: string | null;
  // What the GitHub PR view renders. Null on a row no sweep has rewritten since these columns were
  // added; such a row has no github_number either, so the view does not select it.
  body: string | null;
  // The GitHub PR this item was observed on; a relink keeps the old PR's rows as the de-dup ledger.
  github_number: number | null;
  path: string | null;
  line: number | null;
  in_reply_to_id: number | null;
  review_id: number | null;
  thread_id: string | null;
  thread_resolved: number | null;
  // The content_hash last announced to a Workflow run. It trails content_hash while no run is
  // active, which is how feedback that arrived meanwhile is still announced to the next run.
  notified_hash: string | null;
}

// #2500: every GitHub feedback item observed for one PR, for the PR-detail timeline. Ordered by the
// GitHub-side timestamps so the caller merging them with LoopHub entries gets a stable sequence for
// items that share a second.
export function githubFeedbackObservations(
  issueId: number,
): GithubFeedbackObservation[] {
  return db
    .query(
      `SELECT * FROM github_pull_feedback
       WHERE issue_id = ?
       ORDER BY COALESCE(created_at, updated_at), github_id`,
    )
    .all(issueId) as GithubFeedbackObservation[];
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

export function saveGithubFeedbackObservation(input: {
  issueId: number;
  kind: GithubFeedbackObservation["kind"];
  githubId: number;
  contentHash: string;
  updatedAt: string;
  createdAt?: string | null;
  authorLogin?: string | null;
  reviewState?: string | null;
  url?: string | null;
  body?: string | null;
  githubNumber?: number | null;
  path?: string | null;
  line?: number | null;
  inReplyToId?: number | null;
  reviewId?: number | null;
  threadId?: string | null;
  threadResolved?: boolean | null;
  notifiedHash?: string | null;
}): GithubFeedbackObservation {
  return db
    .query(
      `INSERT INTO github_pull_feedback
         (issue_id, kind, github_id, content_hash, updated_at, observed_at,
          created_at, author_login, review_state, url, body, github_number,
          path, line, in_reply_to_id, review_id, thread_id, thread_resolved, notified_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id, kind, github_id) DO UPDATE SET
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at,
         observed_at = excluded.observed_at,
         created_at = excluded.created_at,
         author_login = excluded.author_login,
         review_state = excluded.review_state,
         url = excluded.url,
         body = excluded.body,
         github_number = excluded.github_number,
         path = excluded.path,
         line = excluded.line,
         in_reply_to_id = excluded.in_reply_to_id,
         review_id = excluded.review_id,
         thread_id = excluded.thread_id,
         thread_resolved = excluded.thread_resolved,
         notified_hash = excluded.notified_hash
       RETURNING *`,
    )
    .get(
      input.issueId,
      input.kind,
      input.githubId,
      input.contentHash,
      input.updatedAt,
      now(),
      input.createdAt ?? null,
      input.authorLogin ?? null,
      input.reviewState ?? null,
      input.url ?? null,
      input.body ?? null,
      input.githubNumber ?? null,
      input.path ?? null,
      input.line ?? null,
      input.inReplyToId ?? null,
      input.reviewId ?? null,
      input.threadId ?? null,
      input.threadResolved == null ? null : Number(input.threadResolved),
      input.notifiedHash ?? null,
    ) as GithubFeedbackObservation;
}

/** The items observed on this GitHub PR that GitHub no longer returns: they were deleted there. */
export function deleteGithubFeedbackObservation(
  row: Pick<GithubFeedbackObservation, "issue_id" | "kind" | "github_id">,
): void {
  db.run(
    `DELETE FROM github_pull_feedback WHERE issue_id = ? AND kind = ? AND github_id = ?`,
    [row.issue_id, row.kind, row.github_id],
  );
}

export function getGithubCheckLog(
  issueId: number,
  jobId: number,
): { excerpt: string; fetched_at: string } | null {
  return (
    (db
      .query(
        `SELECT excerpt, fetched_at FROM github_pull_check_logs
         WHERE issue_id = ? AND job_id = ?`,
      )
      .get(issueId, jobId) as { excerpt: string; fetched_at: string } | null) ??
    null
  );
}

// Keeps only the jobs the PR's current status still names, so re-runs do not accumulate excerpts.
export function saveGithubCheckLog(
  issueId: number,
  jobId: number,
  excerpt: string,
  currentJobIds: number[],
): { excerpt: string; fetched_at: string } {
  return db.transaction(() => {
    db.run(
      `DELETE FROM github_pull_check_logs
       WHERE issue_id = ? AND job_id NOT IN (SELECT value FROM json_each(?))`,
      [issueId, JSON.stringify(currentJobIds)],
    );
    return db
      .query(
        `INSERT INTO github_pull_check_logs (issue_id, job_id, excerpt, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(issue_id, job_id) DO UPDATE SET
           excerpt = excluded.excerpt, fetched_at = excluded.fetched_at
         RETURNING excerpt, fetched_at`,
      )
      .get(issueId, jobId, excerpt, now()) as {
      excerpt: string;
      fetched_at: string;
    };
  });
}

// #800: record that the GitHub PR has been merged (idempotent — re-running after it's already
// flagged just re-sets the same values, since the merge check skips a merged link).
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
