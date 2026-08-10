// Normalizes which Issue, PR, Workflow run, or scheduled task an event is about, so consumers ask
// core for the subject instead of reinterpreting payload keys themselves.
//
// The same subject is spelled differently across namespaces: `number` is the issue on `issue.*` and
// the PR on `pull_request.*`, while a run's PR arrives as `pr_number` but as `number` on older rows.
// Payloads are also unversioned — a row written before a key existed simply lacks it, and legacy
// rows can hold null, an array, or a primitive where an object is expected. Every unknown becomes
// an empty collection here rather than throwing, leaving the consumer on its broad fallback.
//
// Node-free and side-effect free: the web imports it directly, the same way it imports
// core/runtimes.ts.

import type { EventSubjectWire } from "./serialize.ts";

/**
 * The payload as a plain object, or null when it is one of the shapes a keyed read cannot be made
 * on: absent, null, an array, or a primitive. Consumers narrow non-subject metadata through this
 * rather than each inventing their own guard.
 */
export function eventPayloadRecord(
  payload: unknown,
): Readonly<Record<string, unknown>> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return null;
  return payload as Record<string, unknown>;
}

function subjectNumber(
  fields: Readonly<Record<string, unknown>>,
  key: string,
  kind: "issue" | "pull",
): EventSubjectWire[] {
  const value = fields[key];
  return typeof value === "number" ? [{ kind, number: value }] : [];
}

/** The subjects an event names, derived from its type and payload. */
export function eventSubjects(
  type: string,
  payload: unknown,
): EventSubjectWire[] {
  const fields = eventPayloadRecord(payload);
  if (!fields) return [];

  if (type.startsWith("issue.")) {
    return subjectNumber(fields, "number", "issue");
  }
  if (type.startsWith("pull_request.")) {
    return subjectNumber(fields, "number", "pull");
  }
  if (type === "dev.cost_stopped") {
    return subjectNumber(fields, "number", "pull");
  }
  if (type === "agent_session.usage_updated") {
    const runId = fields.id;
    return typeof runId === "number"
      ? [{ kind: "workflow_run", id: runId }]
      : [];
  }
  if (type.startsWith("workflow_run.") || type.startsWith("workflow_step.")) {
    const subjects: EventSubjectWire[] = [];
    const runId = fields.id;
    const issueNumber = fields.issue_number;
    const pullNumber = fields.pr_number ?? fields.number;
    if (typeof runId === "number")
      subjects.push({ kind: "workflow_run", id: runId });
    if (typeof issueNumber === "number")
      subjects.push({ kind: "issue", number: issueNumber });
    if (typeof pullNumber === "number")
      subjects.push({ kind: "pull", number: pullNumber });
    return subjects;
  }
  if (type.startsWith("scheduled_task.")) {
    const id = fields.id;
    return typeof id === "number" ? [{ kind: "scheduled_task", id }] : [];
  }

  return [];
}
