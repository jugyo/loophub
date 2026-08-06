// Which stored events wake a subscriber, and which resources the wake-up names.
//
// A ping says "something you subscribed to may have changed" and nothing else, so this module only
// decides *whether* a row pings and *what identity* the ping carries. It is pure — no database, no
// I/O. Any secondary condition is answered from the event payload alone (today: only a comment's
// `author_type`); the delivery side never reads a subscriber's domain object to filter wakes.
//
// Missing a ping is not a correctness failure: a subscriber reads current state on any later ping,
// so a type absent from the tables below simply never wakes anyone on its own.

import { eventPayloadRecord, eventSubjects } from "./event-subjects.ts";
import type { WorkflowEventType } from "./workflow/event-payloads.ts";

/** A resource identity, spelled the way `lh events subscribe --resource` takes it. */
export interface EventPingResource {
  kind: string;
  key: string;
}

/** The wake-up one stored event asks for. */
export interface EventPingIntent {
  /** The resources the event named; a subscriber to any of them is woken once. */
  resources: EventPingResource[];
}

/** What decides, past the event type, whether a row pings. */
type PingRule =
  /** The type alone decides. */
  | "always"
  /** Human input only: an agent's own posting is a progress note, not an instruction. */
  | "human_author";

/**
 * The run namespace, keyed by type so a new lifecycle event has to declare itself.
 *
 * `null` is a decision, not an omission. The lifecycle transitions are the subscriber's own
 * operations echoed back, the legacy twins have no producer left, and the escalation receipt anchor
 * is deliberately outside the run namespace so replaying the command is not new input.
 */
const WORKFLOW_PING_RULES: Record<WorkflowEventType, PingRule | null> = {
  "workflow_run.started": null,
  "workflow_run.updated": null,
  "workflow_step.launched": null,
  "workflow_run.turn_done": "always",
  "workflow_run.escalated": "always",
  "workflow_run.cost_exceeded": "always",
  "workflow_run.cost_limit_increased": "always",
  "workflow_run.review_submitted": null,
  "workflow_run.merge_conflict": null,
  "workflow_run.merged": null,
  "workflow_run.closed": null,
  "workflow_run.diff_feedback": null,
  "workflow_run.pr_comment": null,
  "workflow_run.github_event": null,
  "workflow_effect.human_escalation": null,
};

/**
 * The issue and PR events that wake a subscriber: human input, an external fact, or a child's
 * report written for the subscriber to read.
 *
 * Everything absent is silent on purpose. A PR closing or merging is read as current state rather
 * than announced, the sweep's HEAD detection fires mid-commit, and UI history events are not
 * anyone's subject.
 */
const SOURCE_PING_RULES: Record<string, PingRule> = {
  "issue.commented": "human_author",
  "pull_request.commented": "human_author",
  "pull_request.diff_feedback_created": "always",
  "pull_request.diff_feedback_replied": "always",
  "pull_request.review_submitted": "always",
  "pull_request.github_feedback": "always",
  "pull_request.merge_conflict": "always",
};

function pingRule(type: string): PingRule | null {
  if (type in WORKFLOW_PING_RULES) {
    return WORKFLOW_PING_RULES[type as WorkflowEventType];
  }
  return SOURCE_PING_RULES[type] ?? null;
}

function pingResource(
  subject: ReturnType<typeof eventSubjects>[number],
): EventPingResource {
  return subject.kind === "issue" || subject.kind === "pull"
    ? { kind: subject.kind, key: String(subject.number) }
    : { kind: subject.kind, key: String(subject.id) };
}

/**
 * The wake-up a stored event asks for, or null when it wakes no one.
 *
 * An event whose payload names no subject also returns null: a ping with no resource has no
 * subscriber to match, and the row is a legacy shape the current producers no longer write.
 */
export function eventPingIntent(
  type: string,
  payload: unknown,
): EventPingIntent | null {
  const rule = pingRule(type);
  if (!rule) return null;
  const fields = eventPayloadRecord(payload);
  if (!fields) return null;
  if (rule === "human_author" && fields.author_type !== "human") return null;
  const resources = eventSubjects(type, payload).map(pingResource);
  if (resources.length === 0) return null;
  return { resources };
}
