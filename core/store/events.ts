import { db, now } from "../db.ts";

export interface EventRow {
  id: number;
  repo_id: number | null;
  type: string;
  actor: string;
  payload: string;
  created_at: string;
}

// ---- events ----
// Persist an event for audit history and cursor-based consumers.
export function emitEvent(
  repoId: number | null,
  type: string,
  actor: string,
  payload: unknown,
): EventRow {
  return db
    .query(
      `INSERT INTO events (repo_id, type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(repoId, type, actor, JSON.stringify(payload), now()) as EventRow;
}
// labels: when set, keep only events whose issue/PR (payload.number, same repo) currently
// carries one of the given label names (OR match). Events without a payload.number are dropped.
// order: "asc" (default) returns the oldest matching events after `since` (used for
// cursor polling forward by id). "desc" returns the newest matching events first
// (the tail), used by dashboard activity feeds that want the most recent N events.
export function listEvents(
  since: number,
  repoId: number | null,
  limit: number,
  labels?: string[],
  order: "asc" | "desc" = "asc",
): EventRow[] {
  const clauses = ["id > ?"];
  const params: unknown[] = [since];
  if (repoId !== null) {
    clauses.push("repo_id = ?");
    params.push(repoId);
  }
  if (labels && labels.length > 0) {
    const placeholders = labels.map(() => "?").join(", ");
    clauses.push(`EXISTS (
      SELECT 1 FROM issues i
      JOIN issue_labels il ON il.issue_id = i.id
      JOIN labels l ON l.id = il.label_id
      WHERE i.repo_id = events.repo_id
        AND i.number = json_extract(events.payload, '$.number')
        AND l.name IN (${placeholders})
    )`);
    params.push(...labels);
  }
  params.push(limit);
  const dir = order === "desc" ? "DESC" : "ASC";
  return db
    .query(
      `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY id ${dir} LIMIT ?`,
    )
    .all(...params) as EventRow[];
}

// The timestamp of the PR's earliest `pull_request.ready_for_review` event, or null if it never
// fired. Both transitions that emit this event type (draft→ready, and re-review after change
// requests — see service.ts `readyForReview`) carry the same `{ number, draft: false }` payload, so
// the earliest one is always the original draft→ready flip — the moment the PR first became
// reviewable. Used to anchor the "work duration" calculation (serialize.ts `pullWorkDuration`) for a
// PR that reached review but hasn't merged yet.
export function firstReadyForReviewAt(
  repoId: number,
  prNumber: number,
): string | null {
  const row = db
    .query(
      `SELECT created_at FROM events
       WHERE repo_id = ? AND type = 'pull_request.ready_for_review'
         AND json_extract(payload, '$.number') = ?
       ORDER BY id ASC LIMIT 1`,
    )
    .get(repoId, prNumber) as { created_at: string } | null;
  return row?.created_at ?? null;
}

// Whether a `dev.cost_stopped` event already exists for a specific dev session on a PR (#832). The
// cost-stop sweep uses this as its idempotency guard: once a session has been stopped for exceeding
// the cost limit, it must not be sent another Esc on every subsequent tick. Keyed on the PR number
// *and* the session_id, so the guard is per dev session, not per PR — a PR that is resumed under a
// new dev session (a new primary dev session) starts with a fresh budget and can be stopped again,
// rather than being permanently exempt because an earlier session was once stopped.
export function hasCostStopEvent(
  repoId: number,
  prNumber: number,
  sessionId: string,
): boolean {
  return !!db
    .query(
      `SELECT 1 AS ok FROM events
       WHERE repo_id = ? AND type = 'dev.cost_stopped'
         AND json_extract(payload, '$.number') = ?
         AND json_extract(payload, '$.session_id') = ?
       LIMIT 1`,
    )
    .get(repoId, prNumber, sessionId);
}

// Whether *any* `dev.cost_stopped` event exists for a PR, regardless of session (#863). Drives the
// "cost stopped" badge shown wherever the PR appears: unlike hasCostStopEvent (the per-session
// idempotency guard for the stop sweep), this asks the display question — "has this PR ever been
// stopped for exceeding its cost limit?" — so a human can spot a stalled PR at a glance.
export function hasAnyCostStopEvent(repoId: number, prNumber: number): boolean {
  return !!db
    .query(
      `SELECT 1 AS ok FROM events
       WHERE repo_id = ? AND type = 'dev.cost_stopped'
         AND json_extract(payload, '$.number') = ?
       LIMIT 1`,
    )
    .get(repoId, prNumber);
}

// Events related to a single PR, newest first. Matches a repo's events whose payload targets
// the PR's own number (pull_request.*), its pr_number (handoff.recorded), or the linked issue's
// number (issue.*) — the union of every number a PR's data is filed under. Used by the debug
// view (service.pulls.debug), which has no id cursor to page through the global feed.
export function eventsForPull(
  repoId: number,
  prNumber: number,
  linkedIssueNumber: number | null,
  limit = 200,
): EventRow[] {
  const numbers = [prNumber];
  if (linkedIssueNumber != null && linkedIssueNumber !== prNumber) {
    numbers.push(linkedIssueNumber);
  }
  const placeholders = numbers.map(() => "?").join(", ");
  return db
    .query(
      `SELECT * FROM events
       WHERE repo_id = ?
         AND (json_extract(payload, '$.number') IN (${placeholders})
              OR json_extract(payload, '$.pr_number') = ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(repoId, ...numbers, prNumber, limit) as EventRow[];
}
