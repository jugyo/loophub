// Normalizes which Issue, PR, Workflow run, or scheduled task an event is about, so consumers ask
// core for the subject instead of reinterpreting payload keys themselves.
//
// The same subject is spelled differently across namespaces: `number` is the issue on `issue.*` and
// the PR on `pull_request.*`, a run's PR arrives as `pr_number` but as `number` on older rows, and
// an agent session names its targets `pr` / `issue`. Payloads are also unversioned — a row written
// before a key existed simply lacks it, and legacy rows can hold null, an array, or a primitive
// where an object is expected. Every unknown reads as `null` here rather than throwing, leaving the
// consumer on whatever broad fallback it already has.
//
// Node-free and side-effect free: the web imports it directly, the same way it imports
// core/runtimes.ts.

import type { EventSubjectWire } from "./serialize.ts";

/** A subject naming nothing — the result for any event type or payload this module can't read. */
export function emptyEventSubject(): EventSubjectWire {
  return {
    issue_number: null,
    pull_number: null,
    workflow_run_id: null,
    scheduled_task_id: null,
  };
}

/**
 * The payload as a plain object, or null when it is one of the shapes a keyed read cannot be made
 * on: absent, null, an array, or a primitive. Consumers narrow non-subject metadata through this
 * rather than each inventing their own guard.
 */
export function eventPayloadFields(
  payload: unknown,
): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return null;
  return payload as Record<string, unknown>;
}

function payloadNumber(
  fields: Record<string, unknown>,
  key: string,
): number | null {
  const value = fields[key];
  return typeof value === "number" ? value : null;
}

/** The subjects an event names, derived from its type and payload. */
export function eventSubject(type: string, payload: unknown): EventSubjectWire {
  const subject = emptyEventSubject();
  const fields = eventPayloadFields(payload);
  if (!fields) return subject;

  if (type.startsWith("issue.")) {
    subject.issue_number = payloadNumber(fields, "number");
  } else if (type.startsWith("pull_request.")) {
    subject.pull_number = payloadNumber(fields, "number");
  } else if (type === "handoff.recorded") {
    // A handoff (#352) is filed against a PR and/or a plain issue; an issue-only handoff carries no
    // PR number at all.
    subject.pull_number =
      payloadNumber(fields, "pr_number") ?? payloadNumber(fields, "number");
    subject.issue_number = payloadNumber(fields, "issue_number");
  } else if (
    type.startsWith("workflow_run.") ||
    type.startsWith("workflow_step.")
  ) {
    // A run's lifecycle payload names all three subjects: the run by `id`, plus the issue and PR it
    // works on.
    subject.workflow_run_id = payloadNumber(fields, "id");
    subject.pull_number =
      payloadNumber(fields, "pr_number") ?? payloadNumber(fields, "number");
    subject.issue_number = payloadNumber(fields, "issue_number");
  } else if (type.startsWith("scheduled_task.")) {
    subject.scheduled_task_id = payloadNumber(fields, "id");
  } else if (type.startsWith("agent_session.")) {
    // Only the events that link a session to a target carry these; the rest name no subject.
    subject.pull_number = payloadNumber(fields, "pr");
    subject.issue_number = payloadNumber(fields, "issue");
  }

  return subject;
}
