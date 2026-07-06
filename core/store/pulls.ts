import { db, now } from "../db.ts";
import type { IssueRow } from "./issues.ts";
import { getIssueById, touchIssue } from "./issues.ts";
import { linkSession, setSessionKind } from "./sessions.ts";

export interface PullRow {
  issue_id: number;
  head_ref: string;
  base_ref: string;
  head_sha: string | null;
  draft: number;
  merged: number;
  merged_at: string | null;
  merge_commit_sha: string | null;
  merge_method: string | null;
  linked_issue_id: number | null;
  changes_addressed_at: string | null;
  changes_addressed_by: string | null;
  linked_issue_closed_event_id: number | null;
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
  number: number;
  author: string;
  head_ref: string;
  head_sha: string | null;
  local_path: string;
}

export interface MainMergeUndoRow {
  id: number;
  repo_id: number;
  pr_id: number;
  linked_issue_id: number | null;
  base_ref: string;
  undone_from_sha: string;
  previous_main_sha: string;
  merge_commit_sha: string;
  pr_metadata_json: string;
  author: string;
  created_at: string;
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
  draft = false,
) {
  db.run(
    `INSERT INTO pulls (issue_id, head_ref, base_ref, head_sha, linked_issue_id, draft)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [issueId, head, base, headSha, linkedIssueId, draft ? 1 : 0],
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
  return db
    .query(
      `SELECT i.*, p.merged
         FROM pulls p
         JOIN issues i ON i.id = p.issue_id
         WHERE p.linked_issue_id = ? AND i.kind = 'pull' AND i.state = 'open' AND p.merged = 0
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

export function setHeadSha(issueId: number, sha: string | null) {
  db.run(`UPDATE pulls SET head_sha = ? WHERE issue_id = ?`, [sha, issueId]);
}

// Flip a PR's draft (#413) WIP flag. `lh pr ready-for-review` clears it (draft→ready).
export function setPullDraft(issueId: number, draft: boolean) {
  db.run(`UPDATE pulls SET draft = ? WHERE issue_id = ?`, [
    draft ? 1 : 0,
    issueId,
  ]);
  touchIssue(issueId);
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
      `SELECT i.id AS issue_id, i.repo_id, i.number, i.author,
              p.head_ref, p.head_sha, r.local_path
       FROM issues i
       JOIN pulls p ON p.issue_id = i.id
       JOIN repos r ON r.id = i.repo_id
       WHERE i.kind = 'pull' AND i.state = 'open' AND p.merged = 0 AND r.archived = 0`,
    )
    .all() as OpenPullSweepRow[];
}

export function setMerged(
  issueId: number,
  sha: string,
  method: string,
): number | null {
  const t = now();
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
     SET merged = 1, merged_at = ?, merge_commit_sha = ?, merge_method = ?,
         linked_issue_closed_event_id = NULL
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

export function setLinkedIssueClosedEvent(
  issueId: number,
  eventId: number | null,
) {
  db.run(
    `UPDATE pulls SET linked_issue_closed_event_id = ? WHERE issue_id = ?`,
    [eventId, issueId],
  );
}

export function undoMainMerge(input: {
  repoId: number;
  issueId: number;
  linkedIssueId?: number | null;
  linkedIssueClosedEventId?: number | null;
  baseRef: string;
  undoneFromSha: string;
  previousMainSha: string;
  mergeCommitSha: string;
  prMetadata: Record<string, unknown>;
  author: string;
}): {
  audit: MainMergeUndoRow;
  linkedIssueReopened: boolean;
  linkedIssueNumber: number | null;
} {
  const t = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    let linkedIssueReopened = false;
    let linkedIssueNumber: number | null = null;
    if (input.linkedIssueId != null) {
      const linked = getIssueById(input.linkedIssueId);
      linkedIssueNumber = linked?.number ?? null;
      linkedIssueReopened =
        linked?.state === "closed" &&
        linkedIssueNumber != null &&
        issueCloseEventIsCurrent(
          input.repoId,
          linkedIssueNumber,
          input.linkedIssueClosedEventId ?? null,
        );
    }
    const audit = db
      .query(
        `INSERT INTO main_merge_undos
           (repo_id, pr_id, linked_issue_id, base_ref, undone_from_sha, previous_main_sha,
            merge_commit_sha, pr_metadata_json, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.repoId,
        input.issueId,
        input.linkedIssueId ?? null,
        input.baseRef,
        input.undoneFromSha,
        input.previousMainSha,
        input.mergeCommitSha,
        JSON.stringify({
          ...input.prMetadata,
          linked_issue_reopened: linkedIssueReopened,
        }),
        input.author,
        t,
      ) as MainMergeUndoRow;
    db.run(
      `UPDATE pulls
       SET merged = 0, merged_at = NULL, merge_commit_sha = NULL, merge_method = NULL,
           linked_issue_closed_event_id = NULL
       WHERE issue_id = ?`,
      [input.issueId],
    );
    db.run(
      `UPDATE issues SET state = 'open', closed_at = NULL, updated_at = ? WHERE id = ?`,
      [t, input.issueId],
    );
    if (input.linkedIssueId != null && linkedIssueReopened) {
      db.run(
        `UPDATE issues SET state = 'open', closed_at = NULL, updated_at = ? WHERE id = ?`,
        [t, input.linkedIssueId],
      );
    }
    db.exec("COMMIT");
    return { audit, linkedIssueReopened, linkedIssueNumber };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

export function listMainMergeUndos(issueId: number): MainMergeUndoRow[] {
  return db
    .query(`SELECT * FROM main_merge_undos WHERE pr_id = ? ORDER BY id ASC`)
    .all(issueId) as MainMergeUndoRow[];
}

export function issueWasClosedByPull(
  repoId: number,
  issueNumber: number,
  pullNumber: number,
): boolean {
  const rows = db
    .query(
      `SELECT payload FROM events WHERE repo_id = ? AND type = 'issue.closed'`,
    )
    .all(repoId) as { payload: string }[];
  return rows.some((row) => {
    try {
      const payload = JSON.parse(row.payload);
      return (
        payload?.number === issueNumber &&
        payload?.closed_by_pull === pullNumber
      );
    } catch {
      return false;
    }
  });
}

export function issueCloseEventIsCurrent(
  repoId: number,
  issueNumber: number,
  eventId: number | null,
): boolean {
  if (eventId == null) return false;
  const row = db
    .query(`SELECT * FROM events WHERE id = ? AND repo_id = ?`)
    .get(eventId, repoId) as { type: string; payload: string } | null;
  if (row?.type !== "issue.closed") return false;
  try {
    const payload = JSON.parse(row.payload);
    if (payload?.number !== issueNumber) return false;
  } catch {
    return false;
  }
  const later = db
    .query(
      `SELECT payload FROM events
       WHERE repo_id = ? AND id > ? AND type IN ('issue.closed', 'issue.reopened')
       ORDER BY id ASC`,
    )
    .all(repoId, eventId) as { payload: string }[];
  return !later.some((event) => {
    try {
      return JSON.parse(event.payload)?.number === issueNumber;
    } catch {
      return false;
    }
  });
}
