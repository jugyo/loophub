import { db, now } from "../db.ts";
import type { MergeableState } from "../mergeable.ts";
import type { IssueRow } from "./issues.ts";
import { getIssueById } from "./issues.ts";
import { linkSession, setSessionKind } from "./sessions.ts";

export interface PullRow {
  issue_id: number;
  head_ref: string;
  base_ref: string;
  base_sha: string | null;
  head_sha: string | null;
  head_pending_creation: number;
  merged: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
  merge_method: string | null;
  linked_issue_id: number | null;
  changes_addressed_at: string | null;
  changes_addressed_by: string | null;
}

export type LinkedPullIssueRow = IssueRow & {
  merged: number;
  merged_at: string | null;
};

export interface OpenPullSummaryRow {
  issue_id: number;
  number: number;
  title: string;
  head_ref: string;
  base_ref: string;
}

export interface OpenPullSweepRow {
  issue_id: number;
  repo_id: number;
  repo_full_name: string;
  number: number;
  author: string;
  head_ref: string;
  base_ref: string;
  head_sha: string | null;
  local_path: string;
}

// ---- pulls ----
export function listPulls(
  repoId: number,
  state: string,
  merged?: "only" | "exclude" | null,
): IssueRow[] {
  const conds = ["i.repo_id = ?", "i.kind = 'pull'"];
  const params: unknown[] = [repoId];
  if (state !== "all") {
    conds.push("i.state = ?");
    params.push(state);
  }
  if (merged === "only") {
    conds.push("p.merged = 1");
  } else if (merged === "exclude") {
    conds.push("p.merged = 0");
  }
  const order =
    merged === "only"
      ? "COALESCE(p.merged_at, i.updated_at) DESC, i.number DESC"
      : "i.number DESC";
  return db
    .query(
      `SELECT i.* FROM issues i
       INNER JOIN pulls p ON p.issue_id = i.id
       WHERE ${conds.join(" AND ")}
       ORDER BY ${order}`,
    )
    .all(...params) as IssueRow[];
}

export function createPull(
  issueId: number,
  head: string,
  base: string,
  headSha: string | null,
  linkedIssueId: number | null = null,
  sessionId: string | null = null,
  baseSha: string | null = null,
  headPendingCreation = false,
) {
  db.run(
    `INSERT INTO pulls
       (issue_id, head_ref, base_ref, base_sha, head_sha, head_pending_creation,
        linked_issue_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      issueId,
      head,
      base,
      baseSha,
      headSha,
      headPendingCreation ? 1 : 0,
      linkedIssueId,
    ],
  );
  // The PR's dev session is recorded only in the generalized session_links bridge (kind='dev'); the
  // PR's resume/retro anchor is derived from there (primaryDevSessionForPull). #316 dropped the
  // denormalized pulls.session_id, so this link is now the single source of truth — mirroring
  // setPullSession, which does the same when the session is (re-)attributed after creation (#298).
  if (sessionId) {
    setSessionKind(sessionId, "dev");
    linkSession(sessionId, issueId);
  }
}

export function openPullLinkedToIssue(
  linkedIssueId: number,
): (IssueRow & { merged: number }) | null {
  // The oldest open PR is the canonical first attempt. Parallel builds inherit its fork point,
  // so make the selection stable even after an issue has multiple open proposal PRs.
  return db
    .query(
      `SELECT i.*, p.merged
         FROM pulls p
         JOIN issues i ON i.id = p.issue_id
         WHERE p.linked_issue_id = ? AND i.kind = 'pull' AND i.state = 'open' AND p.merged = 0
         ORDER BY i.created_at ASC, i.number ASC
         LIMIT 1`,
    )
    .get(linkedIssueId) as (IssueRow & { merged: number }) | null;
}

export function linkedPullForIssue(
  linkedIssueId: number,
): LinkedPullIssueRow | null {
  return db
    .query(
      `SELECT i.*, p.merged, p.merged_at
         FROM pulls p
         JOIN issues i ON i.id = p.issue_id
         WHERE p.linked_issue_id = ? AND i.kind = 'pull'
         ORDER BY CASE WHEN i.state = 'open' AND p.merged = 0 THEN 0 ELSE 1 END,
                  COALESCE(p.merged_at, i.updated_at) DESC
         LIMIT 1`,
    )
    .get(linkedIssueId) as LinkedPullIssueRow | null;
}

// Cap on linked PRs surfaced per issue row. Normally 0–1 exist; the cap only
// bites for an issue that accumulated many (rejected attempts, multi-proposal).
// It bounds both the stacked sub-rows and — more importantly — the per-PR git
// fan-out that the issue list runs to compute each PR's status (see
// serialize.ts issueListItemJSON), keeping a single list page's git work
// bounded regardless of how many PRs an issue collects over time.
export const MAX_LINKED_PULLS = 6;

// Issue detail is the full comparison surface, but each enriched attempt runs
// several git reads. Bound one request so accumulated retry history cannot
// create an unbounded subprocess fan-out. The wire tells the UI when older
// attempts were omitted.
export const MAX_ISSUE_DETAIL_PULLS = 24;

// PRs linked to an issue, most-relevant first (same ordering as
// linkedPullForIssue): open & unmerged ahead of merged/closed, then by recency.
// Capped at MAX_LINKED_PULLS so the issue list can stack them without an
// unbounded git fan-out.
export function linkedPullsForIssue(
  linkedIssueId: number,
): LinkedPullIssueRow[] {
  return db
    .query(
      `SELECT i.*, p.merged, p.merged_at
       FROM pulls p
       JOIN issues i ON i.id = p.issue_id
       WHERE p.linked_issue_id = ? AND i.kind = 'pull'
       ORDER BY CASE WHEN i.state = 'open' AND p.merged = 0 THEN 0 ELSE 1 END,
                COALESCE(p.merged_at, i.updated_at) DESC
       LIMIT ?`,
    )
    .all(linkedIssueId, MAX_LINKED_PULLS) as LinkedPullIssueRow[];
}

// Full linked-PR fan-out for issue detail. Unlike linkedPullsForIssue, this is
// intentionally uncapped: the detail page is the place where the complete issue
// history should be visible.
export function allLinkedPullsForIssue(
  linkedIssueId: number,
): LinkedPullIssueRow[] {
  return db
    .query(
      `SELECT i.*, p.merged, p.merged_at
       FROM pulls p
       JOIN issues i ON i.id = p.issue_id
       WHERE p.linked_issue_id = ? AND i.kind = 'pull'
       ORDER BY CASE WHEN i.state = 'open' AND p.merged = 0 THEN 0 ELSE 1 END,
                COALESCE(p.merged_at, i.updated_at) DESC`,
    )
    .all(linkedIssueId) as LinkedPullIssueRow[];
}

export function getPull(issueId: number): PullRow | null {
  return db
    .query(`SELECT * FROM pulls WHERE issue_id = ?`)
    .get(issueId) as PullRow | null;
}

/** Delete a PR and its PR-scoped metadata without touching any git worktree or ref. */
export function deletePull(
  issueId: number,
  repoId: number,
  number: number,
): void {
  db.transaction(() => {
    // These tables reference issues without ON DELETE CASCADE. Remove only rows owned by this PR;
    // session records, worktrees, and repository-level events remain untouched.
    for (const table of [
      "review_comments",
      "reviews",
      "comments",
      "issue_labels",
      "session_links",
      "github_pull_feedback",
      "github_pull_status",
      "github_pulls",
      "github_issues",
      "issue_search_grams",
    ]) {
      db.run(`DELETE FROM ${table} WHERE issue_id = ?`, [issueId]);
    }
    db.run("DELETE FROM handoffs WHERE pr_id = ?", [issueId]);
    db.run("DELETE FROM retros WHERE pr_id = ?", [issueId]);
    db.run(
      "DELETE FROM pull_conflict_states WHERE repo_id = ? AND pull_number = ?",
      [repoId, number],
    );
    db.run("DELETE FROM pulls WHERE issue_id = ?", [issueId]);
    db.run("DELETE FROM issues WHERE id = ?", [issueId]);
  });
}

export function setHeadSha(issueId: number, sha: string | null) {
  db.run(
    `UPDATE pulls
       SET head_sha = ?,
           head_pending_creation = CASE
             WHEN ? IS NOT NULL THEN 0
             ELSE head_pending_creation
           END
       WHERE issue_id = ?`,
    [sha, sha, issueId],
  );
}

export function listOpenPullsForRepo(repoId: number): OpenPullSummaryRow[] {
  return db
    .query(
      `SELECT p.issue_id, i.number, i.title, p.head_ref, p.base_ref
       FROM pulls p
       JOIN issues i ON i.id = p.issue_id
       WHERE i.repo_id = ? AND i.kind = 'pull' AND i.state = 'open' AND p.merged = 0`,
    )
    .all(repoId) as OpenPullSummaryRow[];
}

// open な PR を repo パス付きで返す（ref スイープ用）
export function openPulls(): OpenPullSweepRow[] {
  return db
    .query(
      `SELECT i.id AS issue_id, i.repo_id, r.full_name AS repo_full_name,
              i.number, i.author,
              p.head_ref, p.base_ref, p.head_sha, r.local_path
       FROM issues i
       JOIN pulls p ON p.issue_id = i.id
       JOIN repos r ON r.id = i.repo_id
       WHERE i.kind = 'pull' AND i.state = 'open' AND p.merged = 0 AND r.archived = 0`,
    )
    .all() as OpenPullSweepRow[];
}

export interface PullConflictTransition {
  // The state recorded on the previous sweep tick, or null the first time this PR is seen.
  previous: MergeableState | null;
  // The state just recorded for this tick.
  current: MergeableState;
}

// Record an open PR's current mergeable state for the conflict sweep (#1232) and return the
// previous vs current pair the sweep needs to detect a clean -> conflict transition. Recording
// every tick makes the sweep idempotent: once `conflict` is stored the previous state stops being
// `clean`, so the transition — and its single event — is not repeated while the PR stays
// conflicted.
export function recordPullConflictState(
  repoId: number,
  pullNumber: number,
  state: MergeableState,
): PullConflictTransition {
  const prev = db
    .query(
      `SELECT state FROM pull_conflict_states
       WHERE repo_id = ? AND pull_number = ?`,
    )
    .get(repoId, pullNumber) as { state: MergeableState } | undefined;
  db.query(
    `INSERT INTO pull_conflict_states (repo_id, pull_number, state, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo_id, pull_number) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at`,
  ).run(repoId, pullNumber, state, now());
  return { previous: prev?.state ?? null, current: state };
}

export function setMerged(
  issueId: number,
  sha: string,
  method: string,
): number | null {
  return finishMerge(issueId, now(), sha, method);
}

function finishMerge(
  issueId: number,
  mergedAt: string,
  sha: string | null,
  method: string,
): number | null {
  const t = mergedAt;
  const pull = getPull(issueId);
  let closedIssue: number | null = null;
  let shouldCloseLinked = false;
  if (pull?.linked_issue_id) {
    const linked = getIssueById(pull.linked_issue_id);
    if (linked?.state === "open") {
      shouldCloseLinked = true;
      closedIssue = linked.number;
    }
  }
  db.run(
    `UPDATE pulls
     SET merged = 1, merged_at = ?, merge_commit_sha = ?, merge_method = ?
     WHERE issue_id = ?`,
    [t, sha, method, issueId],
  );
  // Sets closed_at alongside state (not via updateIssue, which this bypasses) so the "closed_at is
  // stamped whenever state transitions to closed" invariant holds for every close path, even though
  // pullWorkDuration never actually reads it here (a merged PR's "merged" branch — p.merged &&
  // p.merged_at — always wins first, see serialize.ts).
  db.run(
    `UPDATE issues SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`,
    [t, t, issueId],
  );
  if (pull?.linked_issue_id && shouldCloseLinked) {
    db.run(
      `UPDATE issues SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`,
      [t, t, pull.linked_issue_id],
    );
  }
  return closedIssue;
}
