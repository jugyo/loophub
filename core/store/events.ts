import { db, now } from "../db.ts";
import { pingEventSubscribers } from "../event-ping-delivery.ts";
import type {
  WorkflowEventPayloadMap,
  WorkflowEventType,
} from "../workflow/event-payloads.ts";
import { SOURCE_PAYLOAD_VERSION } from "../workflow/source-events.ts";

export interface EventRow {
  id: number;
  repo_id: number | null;
  type: string;
  actor: string;
  payload: string;
  created_at: string;
}

export interface EventFilters {
  types?: string[];
  runId?: number;
}

// ---- events ----
/**
 * Announce a row that was really inserted to whoever subscribed to what it names.
 *
 * Every `INSERT INTO events` in this module passes its statement's result through here, so the
 * seam is one helper rather than one insert function — the two conditional inserts below cannot be
 * folded into `emitEvent()` without breaking the single statement their dedupe depends on.
 *
 * What is passed is the *statement's* result, never the enclosing function's return value:
 * `getOrCreateWorkflowHumanEscalationEvent()` answers with an existing row when its insert finds
 * one, and announcing that would be a wake-up with no new fact behind it. A statement that inserted
 * nothing is exactly the case where nothing changed.
 */
function recordEventPing<T extends EventRow | null>(inserted: T): T {
  if (inserted) pingEventSubscribers(inserted);
  return inserted;
}

// Persist an event for audit history and cursor-based consumers.
export function emitEvent(
  repoId: number | null,
  type: string,
  actor: string,
  payload: unknown,
): EventRow {
  return recordEventPing(
    db
      .query(
        `INSERT INTO events (repo_id, type, actor, payload, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(repoId, type, actor, JSON.stringify(payload), now()) as EventRow,
  );
}

// Emit a workflow event with its payload checked against the shared payload map, so the keys the
// run's projection reads back cannot drift from the keys written here.
export function emitWorkflowEvent<T extends WorkflowEventType>(
  repoId: number,
  type: T,
  actor: string,
  payload: WorkflowEventPayloadMap[T],
): EventRow {
  return emitEvent(repoId, type, actor, payload);
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
  filters: EventFilters = {},
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
  if (filters.types && filters.types.length > 0) {
    const typeClauses = filters.types.map((type) => {
      if (type.includes(".")) {
        params.push(type);
        return "type = ?";
      }
      const escaped = type.replaceAll("\\", "\\\\").replaceAll("%", "\\%");
      params.push(`${escaped.replaceAll("_", "\\_")}.%`);
      return "type LIKE ? ESCAPE '\\'";
    });
    clauses.push(`(${typeClauses.join(" OR ")})`);
  }
  if (filters.runId !== undefined) {
    clauses.push("json_extract(payload, '$.id') = ?");
    params.push(filters.runId);
  }
  params.push(limit);
  const dir = order === "desc" ? "DESC" : "ASC";
  return db
    .query(
      `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY id ${dir} LIMIT ?`,
    )
    .all(...params) as EventRow[];
}

/**
 * The id of the run's `workflow_run.started` event, or null when the run has none.
 *
 * This is the lower bound of the run's attempt window: a PR may be attempted more than once, and
 * the start is what tells this attempt's reviews from an earlier one's. A missing start leaves the
 * run with its lifecycle-only trail rather than falling back to 0, so no other attempt's history is
 * read as this run's work.
 */
export function workflowRunStartedEventId(
  repoId: number,
  runId: number,
): number | null {
  const row = db
    .query(
      `SELECT id FROM events
       WHERE repo_id = ? AND type = 'workflow_run.started'
         AND json_extract(payload, '$.id') = ?
       ORDER BY id ASC LIMIT 1`,
    )
    .get(repoId, runId) as { id: number } | null;
  return row?.id ?? null;
}

/**
 * The `workflow_run.started` id of the next run on the same PR, or null when this is the latest
 * attempt.
 *
 * A PR can be attempted more than once, and the run id in a lifecycle payload keeps those attempts
 * apart on its own. A review source carries only the PR number, so its attempt is decided by where
 * it sits between the two starts — this is the upper end of that window.
 */
export function nextWorkflowRunStartedEventId(input: {
  repoId: number;
  prNumber: number;
  afterRunId: number;
}): number | null {
  const row = db
    .query(
      `SELECT min(started.id) AS id FROM events started
       JOIN workflow_runs later
         ON later.id = json_extract(started.payload, '$.id')
       WHERE started.repo_id = ? AND started.type = 'workflow_run.started'
         AND later.repo_id = ? AND later.pr_number = ? AND later.id > ?`,
    )
    .get(input.repoId, input.repoId, input.prNumber, input.afterRunId) as {
    id: number | null;
  } | null;
  return row?.id ?? null;
}

/**
 * The trail a run's projection is derived from: its own lifecycle events, plus the marked
 * `pull_request.review_submitted` sources that now announce its reviews, in event id order.
 *
 * The run's review submissions used to arrive only as `workflow_run.review_submitted` twins. With
 * those producers gone, the source event is the submission boundary, and reading both keeps the
 * boundary intact for runs that started before the cutover. A source belongs to this run only
 * inside its attempt window — after its own start, before the next run's — so neither an earlier
 * attempt's reviews nor a later one's are read as this run's work. Unmarked sources are left out
 * entirely, because for those the legacy twin is still the boundary.
 */
export function workflowRunObservationTrail(input: {
  repoId: number;
  runId: number;
  prNumber: number;
  startedEventId: number;
  nextRunStartedEventId: number | null;
}): EventRow[] {
  return db
    .query(
      `SELECT * FROM events
       WHERE repo_id = ?
         AND (
           ((type GLOB 'workflow_run.*' OR type GLOB 'workflow_step.*')
              AND json_extract(payload, '$.id') = ?)
           OR (type = 'pull_request.review_submitted'
              AND json_extract(payload, '$.number') = ?
              AND json_extract(payload, '$.source_payload_version') = ?
              AND id > ? AND id < ?)
         )
       ORDER BY id ASC`,
    )
    .all(
      input.repoId,
      input.runId,
      input.prNumber,
      SOURCE_PAYLOAD_VERSION,
      input.startedEventId,
      input.nextRunStartedEventId ?? Number.MAX_SAFE_INTEGER,
    ) as EventRow[];
}

// Workflow lifecycle events for one run, oldest first. Match the run id directly rather than the
// issue / PR numbers also carried in these payloads: a PR may have successive runs, and its history
// dialog must never blend their timelines. The GLOB pair and the CAST are what let this seek
// idx_events_repo_workflow_run_id instead of scanning the repo's events (see db.ts).
export function eventsForWorkflowRun(
  repoId: number,
  runId: number,
): EventRow[] {
  return db
    .query(
      `SELECT * FROM events
       WHERE repo_id = ?
         AND (type GLOB 'workflow_run.*'
           OR type GLOB 'workflow_step.*')
         AND CAST(json_extract(payload, '$.id') AS INTEGER) = ?
       ORDER BY id ASC`,
    )
    .all(repoId, runId) as EventRow[];
}

// Cost detection runs on every usage sweep, so this INSERT collapses a run's repeated over-limit
// observations into at most one event per `reemitAfterMs` for the same cumulative limit (#1844).
// It re-emits rather than emitting once: a parent that stopped between the delivered instruction
// and `cost-hold` would otherwise never see the interrupt again, because the worker advances its
// cursor once the instruction is delivered. The caller stops asking once the run is held or its
// limit is raised.
export function emitWorkflowRunCostExceeded(
  repoId: number,
  actor: string,
  payload: WorkflowEventPayloadMap["workflow_run.cost_exceeded"],
  reemitAfterMs: number,
): EventRow | null {
  // Same second-precision shape as `now()`, so the cutoff compares lexicographically against
  // stored `created_at` values.
  const reemitAfter = new Date(Date.now() - reemitAfterMs)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  return recordEventPing(
    (db
      .query(
        `INSERT INTO events (repo_id, type, actor, payload, created_at)
         SELECT ?, 'workflow_run.cost_exceeded', ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM events
           WHERE repo_id = ? AND type = 'workflow_run.cost_exceeded'
             AND json_extract(payload, '$.id') = ?
             AND json_extract(payload, '$.limit_usd') = ?
             AND created_at > ?
         )
         RETURNING *`,
      )
      .get(
        repoId,
        actor,
        JSON.stringify(payload),
        now(),
        repoId,
        payload.id,
        payload.limit_usd,
        reemitAfter,
      ) as EventRow | null) ?? null,
  );
}

// `escalate-human` owns the human notification and therefore needs one stable event id even
// when the escalation was decided by parent reconciliation rather than an incoming run event.
// Keeping this internal receipt anchor outside the workflow_run namespace prevents the parent
// watch loop from treating command replay as new orchestration input.
export function getOrCreateWorkflowHumanEscalationEvent(
  repoId: number,
  actor: string,
  payload: WorkflowEventPayloadMap["workflow_effect.human_escalation"],
): EventRow {
  const inserted = recordEventPing(
    db
      .query(
        `INSERT INTO events (repo_id, type, actor, payload, created_at)
       SELECT ?, 'workflow_effect.human_escalation', ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM events
         WHERE repo_id = ? AND type = 'workflow_effect.human_escalation'
           AND json_extract(payload, '$.id') = ?
           AND json_extract(payload, '$.reason') = ?
       )
       RETURNING *`,
      )
      .get(
        repoId,
        actor,
        JSON.stringify(payload),
        now(),
        repoId,
        payload.id,
        payload.reason,
      ) as EventRow | null,
  );
  if (inserted) return inserted;
  return db
    .query(
      `SELECT * FROM events
       WHERE repo_id = ? AND type = 'workflow_effect.human_escalation'
         AND json_extract(payload, '$.id') = ?
         AND json_extract(payload, '$.reason') = ?
       ORDER BY id ASC LIMIT 1`,
    )
    .get(repoId, payload.id, payload.reason) as EventRow;
}

// The event a run's `cost.hold` receipt anchors to at one cumulative limit. Detection re-emits
// while a parent is away (#1844), so the same limit accumulates several events that all ask for the
// one interrupt it warrants; the oldest is the stable anchor no matter when the parent gets there.
export function firstWorkflowRunCostExceededEvent(
  repoId: number,
  runId: number,
  limitUsd: number,
): EventRow | null {
  return (
    (db
      .query(
        `SELECT * FROM events
         WHERE repo_id = ? AND type = 'workflow_run.cost_exceeded'
           AND json_extract(payload, '$.id') = ?
           AND json_extract(payload, '$.limit_usd') = ?
         ORDER BY id ASC LIMIT 1`,
      )
      .get(repoId, runId, limitUsd) as EventRow | null) ?? null
  );
}

// Deliberately its own query rather than a `!!first…()` delegation. The ordering the anchor lookup
// needs is satisfied from `idx_events_repo` (repo_id, id), which walks the repo's events; unordered,
// this one seeks `idx_events_repo_type_number_session_id` (repo_id, type, …) instead. That index is
// not in `core/db.ts` — installs created before it was dropped from the schema still carry it, and
// on one such database (207k events, 151k of them in the repo measured) the two plans are ~0.03 ms
// against ~19 ms. A database created by the current schema sees no difference, so the duplication
// buys nothing there; on the ones that do differ, existence is asked on every poll of a held run —
// exactly while a human is on the page deciding whether to raise the limit.
export function hasWorkflowRunCostExceededEvent(
  repoId: number,
  runId: number,
  limitUsd: number,
): boolean {
  return !!db
    .query(
      `SELECT 1 AS ok FROM events
       WHERE repo_id = ? AND type = 'workflow_run.cost_exceeded'
         AND json_extract(payload, '$.id') = ?
         AND json_extract(payload, '$.limit_usd') = ?
       LIMIT 1`,
    )
    .get(repoId, runId, limitUsd);
}

// The timestamp of the run's latest turn-done declaration, or null when Execute never declared
// one. A timing signal for the parent's observation — never step-completion truth.
export function latestWorkflowTurnDoneAt(
  repoId: number,
  runId: number,
): string | null {
  const row = db
    .query(
      `SELECT created_at FROM events
       WHERE repo_id = ? AND type = 'workflow_run.turn_done'
         AND json_extract(payload, '$.id') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId, runId) as { created_at: string } | null;
  return row?.created_at ?? null;
}

// The timestamp of the PR's earliest `pull_request.ready_for_review` event, or null if it never
// fired. The event is emitted when a PR is resubmitted after change requests (see service.ts
// Historical data can contain several such events, and the earliest one marks when the PR first
// entered review. Used to
// anchor the "work duration" calculation (serialize.ts `pullWorkDuration`) for a
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

// Whether *any* `dev.cost_stopped` event exists for a PR, regardless of session (#863). Drives the
// "cost stopped" badge shown wherever the PR appears. This asks the display question — "has this PR
// ever been stopped for exceeding its cost limit?" — so a human can spot a stalled PR at a glance.
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
