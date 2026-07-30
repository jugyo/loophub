import type { StoredWorkflowEventPayload } from "./event-payloads.ts";
import { workflowStepSessionIds } from "./herdr-agents.ts";

/**
 * A Workflow run observes its own run events plus the issue and PR events of the subjects it owns.
 *
 * Before this, every PR fact a parent had to react to was announced twice: once as the ordinary
 * source event, and once as a run-scoped `workflow_run.*` twin written by a producer that had to
 * resolve the run itself. The twins are gone. What remains is the question they answered by
 * accident — for one selected row, was the instruction it implies already taken from another row?
 *
 * The answer is a property of the row, not of the clock: a source written by a cutover producer
 * carries {@link SOURCE_PAYLOAD_VERSION}, and a twin names the source it was projected from. So a
 * database holding rows from both sides of the deploy is classified row by row, with no cursor
 * migration and no repository-wide cutover timestamp.
 *
 * This module is pure: it classifies a selected row and is handed every lookup it needs.
 */

/**
 * The version of the source payload contract. A source event carrying it holds the stable ids and
 * producer session id the run reads, so the run builds its instruction from the source itself. Rows
 * written before the cutover lack it and only wake the run's state observation — their legacy twin
 * is still the one instruction they produce.
 */
export const SOURCE_PAYLOAD_VERSION = 1;

/**
 * The exclusive lower bound of a run's subscription: everything recorded before the run started is
 * out, and so is everything its cursor already consumed.
 *
 * A run subscribes to its whole issue and PR, not only to events written for it, so without this
 * bound a run whose cursor predates the widening would wake once for every issue and PR event
 * recorded before it began — preventing that needs the run's own start, not a cursor migration.
 * The start itself stays selectable: it is the event that tells the consumer to launch Execute, so
 * a run that has consumed nothing yet still gets its first instruction from it.
 */
export function workflowSubscriptionLowerBound(
  cursor: number,
  startedEventId: number,
): number {
  return Math.max(cursor, startedEventId - 1);
}

/** What the run should do with one selected subject event. */
export type WorkflowSubjectEventRole =
  /** Build the run's instruction from this row. */
  | "instruction"
  /** Re-observe run state, but take no instruction from this payload. */
  | "wake_only"
  /** A legacy twin whose marked source already provided the instruction. */
  | "superseded";

/** How a legacy twin points back at the source event it was projected from. */
export type WorkflowTwinSourceRef =
  | { kind: "event"; sourceEventId: number }
  | { kind: "review"; reviewId: number };

/** The subset of a selected event row this classification reads. */
export interface WorkflowSubjectEvent {
  type: string;
  payload: StoredWorkflowEventPayload;
}

/** Whether a type belongs to the run's own lifecycle rather than to its issue / PR subjects. */
export function isWorkflowRunEventType(type: string): boolean {
  return type.startsWith("workflow_run.") || type.startsWith("workflow_step.");
}

/** The notification-only twins whose producers this change removed. */
const TWIN_EVENT_TYPES = new Set([
  "workflow_run.closed",
  "workflow_run.merged",
  "workflow_run.merge_conflict",
  "workflow_run.diff_feedback",
  "workflow_run.pr_comment",
  "workflow_run.github_event",
]);

/**
 * The source a stored twin announced, or null when the row is an ordinary run lifecycle event.
 *
 * `workflow_run.review_submitted` never carried `source_event_id`, so the review it announces is
 * the only reference that identifies its source across every stored row.
 */
export function workflowTwinSourceRef(
  event: WorkflowSubjectEvent,
): WorkflowTwinSourceRef | null {
  if (event.type === "workflow_run.review_submitted") {
    const reviewId = event.payload.review_id;
    return typeof reviewId === "number" ? { kind: "review", reviewId } : null;
  }
  if (!TWIN_EVENT_TYPES.has(event.type)) return null;
  const sourceEventId = event.payload.source_event_id;
  return typeof sourceEventId === "number"
    ? { kind: "event", sourceEventId }
    : null;
}

/** Whether a source payload was written by a producer on the cutover side of the deploy. */
export function isMarkedWorkflowSource(
  payload: StoredWorkflowEventPayload,
): boolean {
  return payload.source_payload_version === SOURCE_PAYLOAD_VERSION;
}

/**
 * Classify one selected subject event.
 *
 * `markedSourceExists` answers whether the source a twin names carries the cutover marker; it is a
 * lookup because only the store can see the other row. It is consulted for twins only.
 */
export function classifyWorkflowSubjectEvent(
  event: WorkflowSubjectEvent,
  markedSourceExists: (ref: WorkflowTwinSourceRef) => boolean,
): WorkflowSubjectEventRole {
  if (isWorkflowRunEventType(event.type)) {
    const ref = workflowTwinSourceRef(event);
    return ref && markedSourceExists(ref) ? "superseded" : "instruction";
  }
  return isMarkedWorkflowSource(event.payload) ? "instruction" : "wake_only";
}

/** The session identity of a run, as the echo check reads it off the run row. */
export interface WorkflowRunSessions {
  parent_session_id: string | null;
  step_sessions_json: string;
}

/**
 * Whether a source event was written by the run's own parent or one of the children it launched.
 *
 * Execute answers a diff feedback thread by replying to it. Waking the parent on that reply would
 * deliver the run's own answer straight back to the child that wrote it, so the run's own writes
 * advance the cursor without becoming an instruction.
 */
export function isWorkflowRunOwnSession(
  run: WorkflowRunSessions,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  return (
    sessionId === run.parent_session_id ||
    workflowStepSessionIds(run.step_sessions_json, "execute").includes(
      sessionId,
    ) ||
    workflowStepSessionIds(run.step_sessions_json, "verify").includes(sessionId)
  );
}
