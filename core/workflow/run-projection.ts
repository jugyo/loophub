import type { WorkflowStep } from "./compose.ts";
import {
  parseWorkflowEventPayload,
  type StoredWorkflowEventPayload,
} from "./event-payloads.ts";

/**
 * One pass over a run's event trail, producing every observation the run's state is derived from.
 *
 * The trail is the run's only record of what its children did, and observing it used to mean
 * loading it again per question — `lh workflow next` alone re-ran `eventsForWorkflowRun` five times
 * and re-scanned the result with a fresh `findLast` each time. The observations below are all the
 * questions that were being asked, answered once from one ordered pass, so the callers take a
 * projection instead of a repo id and a run id.
 *
 * This module is pure: it reads the rows it is handed and touches neither the DB nor git.
 */

/** The subset of a stored event row this projection reads. */
export interface WorkflowRunEventRow {
  id: number;
  type: string;
  payload: string;
  created_at: string;
}

/** A run event with its payload parsed exactly once. */
export interface WorkflowRunEvent {
  id: number;
  type: string;
  payload: StoredWorkflowEventPayload;
  created_at: string;
}

/**
 * The `workflow_run.review_submitted` events for one review. A review can be announced more than
 * once on a run's trail, and the two ends answer different questions: `first` is the submission
 * boundary an out-of-band review is measured from, `latest` is the most recent announcement a turn
 * done is compared against.
 */
export interface WorkflowReviewSubmission {
  first: WorkflowRunEvent;
  latest: WorkflowRunEvent;
}

export interface WorkflowRunProjection {
  /** Every run event, oldest first, as the store returned them. */
  events: WorkflowRunEvent[];
  /** Every `workflow_run.turn_done`, oldest first. */
  turnDones: WorkflowRunEvent[];
  /** The run's latest turn-done declaration, or null when Execute never made one. */
  latestTurnDone: WorkflowRunEvent | null;
  /** The latest Verify launch, used to tell whether it could have seen a given turn done. */
  latestVerifyLaunch: WorkflowRunEvent | null;
  /**
   * The latest event that put an Execute child to work: a Verify-phase run reactivates Execute for
   * live input via `activate_step` rather than a fresh launch, so both count.
   */
  latestExecuteRound: WorkflowRunEvent | null;
  /** Review submissions on this run's trail, keyed by review id. */
  reviewSubmissions: Map<number, WorkflowReviewSubmission>;
  /**
   * The `workflow_run.updated` events that resolved a current step, oldest first. Phase lookups
   * walk this instead of the whole trail.
   */
  phaseTransitions: { id: number; step: WorkflowStep }[];
}

export function projectWorkflowRunEvents(
  rows: readonly WorkflowRunEventRow[],
): WorkflowRunProjection {
  const events: WorkflowRunEvent[] = [];
  const turnDones: WorkflowRunEvent[] = [];
  const reviewSubmissions = new Map<number, WorkflowReviewSubmission>();
  const phaseTransitions: { id: number; step: WorkflowStep }[] = [];
  let latestVerifyLaunch: WorkflowRunEvent | null = null;
  let latestExecuteRound: WorkflowRunEvent | null = null;

  for (const row of rows) {
    const event: WorkflowRunEvent = {
      id: row.id,
      type: row.type,
      payload: parseWorkflowEventPayload(row.payload) ?? {},
      created_at: row.created_at,
    };
    events.push(event);
    const payload = event.payload;
    if (event.type === "workflow_run.turn_done") {
      turnDones.push(event);
    } else if (event.type === "workflow_step.launched") {
      if (payload.step === "verify") latestVerifyLaunch = event;
      if (payload.step === "execute") latestExecuteRound = event;
    } else if (event.type === "workflow_run.updated") {
      if (
        payload.transition === "activate_step" &&
        payload.active_step === "execute"
      ) {
        latestExecuteRound = event;
      }
      // `activate_step` deliberately does not move the phase: it reactivates an Execute pane for
      // live input (e.g. a cost-hold resume) without leaving the Verify phase, so keying off
      // `active_step` mis-reads a verifying run as executing (#1873).
      if (
        payload.current_step === "execute" ||
        payload.current_step === "verify"
      ) {
        phaseTransitions.push({ id: event.id, step: payload.current_step });
      }
    } else if (event.type === "workflow_run.review_submitted") {
      const reviewId = payload.review_id;
      if (typeof reviewId === "number") {
        const existing = reviewSubmissions.get(reviewId);
        reviewSubmissions.set(
          reviewId,
          existing
            ? { first: existing.first, latest: event }
            : { first: event, latest: event },
        );
      }
    }
  }

  return {
    events,
    turnDones,
    latestTurnDone: turnDones.at(-1) ?? null,
    latestVerifyLaunch,
    latestExecuteRound,
    reviewSubmissions,
    phaseTransitions,
  };
}

/**
 * The run's phase at the time `eventId` was recorded. A run starts in Execute before any
 * transition, so an event that predates every recorded `current_step` reads as Execute.
 */
export function workflowStepPhaseAt(
  projection: WorkflowRunProjection,
  eventId: number,
): WorkflowStep {
  let phase: WorkflowStep = "execute";
  for (const transition of projection.phaseTransitions) {
    if (transition.id > eventId) break;
    phase = transition.step;
  }
  return phase;
}
