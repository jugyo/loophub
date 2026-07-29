import type { GithubPrFeedbackKind } from "../github.ts";
import type { WorkflowStep } from "./compose.ts";

/**
 * The payload shapes of the events a workflow run's timeline is derived from.
 *
 * Writers emit through {@link WorkflowEventPayloadMap}; readers see the same shapes through
 * {@link StoredWorkflowEventPayload}, which is derived from the map rather than restated. That is
 * the point of this module: before it, each reader re-declared the keys it expected in a local
 * `JSON.parse(...) as { … }` cast, so a renamed key stayed silent until a run misbehaved.
 *
 * The map is a contract about what is written from now on, not a validation of what is stored. Rows
 * emitted before a key existed are still read back, so the read view keeps every key optional and
 * readers keep the `typeof` narrowing they already had.
 */

/** The lifecycle move a `workflow_run.updated` event records. */
export type WorkflowRunTransition =
  | "complete"
  | "advance_to_verify"
  | "activate_step"
  | "await_human"
  | "resume_after_human"
  | "request_rework";

/**
 * `id` is the run id every run-scoped payload carries — `eventsForWorkflowRun` selects on it, so a
 * payload without it never reaches a run's timeline at all.
 */
interface WorkflowRunScoped {
  id: number;
}

/**
 * Both issue and PR numbers travel with the events the Web surfaces react to, so issue and PR
 * detail can refresh their run-state query precisely (#1008).
 */
interface WorkflowRunSubject {
  issue_number: number;
  pr_number: number;
}

/**
 * The run's parent pane is the delivery target for the events the worker forwards, and `number`
 * lets the generic pub/sub notify line name the PR.
 */
interface WorkflowRunDelivery {
  number: number;
  parent_session_id: string | null;
}

/** The source event a run-scoped projection was derived from (see core/pull-conflict-events.ts). */
interface WorkflowRunProjectionSource {
  source_event_id: number;
  source_event_type: string;
}

/**
 * One changed GitHub feedback item, reduced to its canonical `gh api` path. Only the reference is
 * projected: the parent must read the resource itself rather than trust a copy of untrusted comment
 * text travelling through LoopHub.
 */
export interface WorkflowGithubFeedbackItem {
  kind: GithubPrFeedbackKind;
  id: number;
  updated_at: string;
  reference: string;
}

/** Emit-side payload shape per event type. */
export interface WorkflowEventPayloadMap {
  "workflow_run.started": WorkflowRunScoped &
    WorkflowRunSubject & {
      workflow_id: number;
      session_id: string | null | undefined;
    };
  "workflow_run.updated": WorkflowRunScoped &
    WorkflowRunSubject & {
      transition: WorkflowRunTransition;
      status: string;
      current_step: string;
      rework_count: number;
      /**
       * Present only when the update touched the human wait (#1307): a string marks the
       * escalation, an explicit null marks the human-instructed resume.
       */
      needs_human_reason?: string | null;
      /** Present only on `activate_step`, which names the pane taking live input. */
      active_step?: string | null;
      active_session_id?: string | null;
    };
  "workflow_step.launched": WorkflowRunScoped &
    WorkflowRunSubject & {
      step: WorkflowStep;
      session_id: string;
      handoff_id: number;
    };
  "workflow_run.turn_done": WorkflowRunScoped &
    WorkflowRunSubject &
    WorkflowRunDelivery & {
      session_id: string | null;
      head_sha: string;
    };
  "workflow_run.escalated": WorkflowRunScoped &
    WorkflowRunSubject &
    WorkflowRunDelivery & {
      session_id: string | null;
      reason: string;
    };
  "workflow_run.review_submitted": WorkflowRunScoped &
    WorkflowRunSubject &
    WorkflowRunDelivery & {
      session_id: string | null;
      review_id: number;
      submission_head_sha: string | null;
    };
  "workflow_run.cost_exceeded": WorkflowRunScoped &
    WorkflowRunDelivery & {
      pr_number: number;
      /**
       * Legacy alias retained for existing event readers. New orchestration must use the explicit
       * usage/active fields below so the session whose aggregate changed is never treated as the
       * pane that should be interrupted.
       */
      session_id: string;
      usage_session_id: string;
      active_step: string | null;
      active_session_id: string | null;
      cost_usd: number;
      limit_usd: number;
      increment_usd: number;
      next_limit_usd: number;
    };
  "workflow_run.cost_limit_increased": WorkflowRunScoped &
    WorkflowRunSubject & {
      active_step: string | null;
      increment_usd: number;
      previous_limit_usd: number;
      current_limit_usd: number;
    };
  "workflow_run.merge_conflict": WorkflowRunScoped &
    WorkflowRunDelivery &
    WorkflowRunProjectionSource & { pr_number: number };
  /** Legacy merge trigger retained for typed reads of persisted events; new writers emit closed. */
  "workflow_run.merged": WorkflowRunScoped &
    WorkflowRunDelivery &
    WorkflowRunProjectionSource & { pr_number: number };
  "workflow_run.closed": WorkflowRunScoped &
    WorkflowRunDelivery &
    WorkflowRunProjectionSource & { pr_number: number };
  /**
   * A diff feedback comment landed on the run's PR (#2045). Only the ids travel: the comment, its
   * anchor and its body stay canonical in the DB, which Execute reads back with `lh pr feedback`.
   */
  "workflow_run.diff_feedback": WorkflowRunScoped &
    WorkflowRunDelivery &
    WorkflowRunProjectionSource & {
      pr_number: number;
      thread_id: number;
      comment_id: number;
    };
  "workflow_run.pr_comment": WorkflowRunScoped &
    WorkflowRunDelivery &
    WorkflowRunProjectionSource & {
      pr_number: number;
      comment_id: number;
      author: string;
      body: string;
    };
  "workflow_run.github_event": WorkflowRunScoped &
    WorkflowRunDelivery &
    WorkflowRunProjectionSource & {
      pr_number: number;
      github_number: number;
      github_url: string;
      feedback: WorkflowGithubFeedbackItem[];
    };
  /** `escalate-human`'s receipt anchor, kept outside the `workflow_run` namespace on purpose. */
  "workflow_effect.human_escalation": WorkflowRunScoped & {
    issue_number: number;
    reason: string;
  };
}

export type WorkflowEventType = keyof WorkflowEventPayloadMap;

type WorkflowEventPayload = WorkflowEventPayloadMap[WorkflowEventType];

// Distribute over the payload union: `keyof (A | B)` alone would keep only the keys every payload
// has, and these helpers want the keys any payload has, each with the types its writers give it.
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type ValueOfUnion<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : never
  : never;

type WorkflowEventPayloadKey = KeysOfUnion<WorkflowEventPayload>;

/**
 * Read-side view of any stored workflow event payload: every key the writers above can produce,
 * all optional.
 *
 * Optional is the honest shape. A row emitted before a key existed simply lacks it, and the
 * timeline must keep reading such rows with the same fallbacks as before, so readers still narrow
 * (`typeof x === "string"`) exactly where they did with the old ad-hoc casts. What the type buys is
 * that the *names and types* now come from the emit map: renaming a key on the write side breaks
 * its readers at compile time.
 */
export type StoredWorkflowEventPayload = {
  [K in WorkflowEventPayloadKey]?: ValueOfUnion<WorkflowEventPayload, K>;
};

/**
 * View an already-parsed payload as a stored workflow payload. Anything that is not a JSON object
 * reads as an empty payload, which lands every reader on its missing-key fallback.
 */
export function workflowEventPayloadOf(
  value: unknown,
): StoredWorkflowEventPayload {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as StoredWorkflowEventPayload)
    : {};
}

/**
 * Parse a stored payload column, or null when the row does not hold a JSON object. Callers that
 * must reject a malformed row use the null; callers that only read best-effort fields fold it into
 * an empty payload with `?? {}`.
 */
export function parseWorkflowEventPayload(
  payload: string,
): StoredWorkflowEventPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as StoredWorkflowEventPayload)
    : null;
}

/**
 * The canonical `gh api` paths a `workflow_run.github_event` recorded for the changed items. Items
 * without a string reference are dropped: legacy rows may carry a different item shape.
 */
export function workflowGithubFeedbackReferences(
  payload: StoredWorkflowEventPayload,
): string[] {
  const feedback: unknown = payload.feedback;
  if (!Array.isArray(feedback)) return [];
  return feedback
    .map((item: unknown) =>
      item && typeof item === "object"
        ? (item as { reference?: unknown }).reference
        : undefined,
    )
    .filter((reference): reference is string => typeof reference === "string");
}
