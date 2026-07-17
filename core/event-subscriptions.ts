// Pure decisioning for the worker's generic event pub/sub (#1232): which events are eligible for
// subscriber notification, and what text gets injected into a subscriber's herdr pane. The
// side-effectful parts (DB lookups, the herdr spawn) live in core/service/subscriptions.ts.

// Namespace of the audit events the notify path itself emits. Notifying subscribers *of these*
// would let a subscription to `event_subscription.notified` produce a new notified event per
// notify — an infinite event loop — so the whole namespace is excluded from pub/sub delivery.
export const SUBSCRIPTION_EVENT_PREFIX = "event_subscription.";

// Whether an event type is eligible for subscriber notification at all.
export function notifiableEventType(eventType: string): boolean {
  return !eventType.startsWith(SUBSCRIPTION_EVENT_PREFIX);
}

export interface NotifyTextInput {
  eventType: string;
  repoFullName: string;
  eventId: number;
  // payload.number when present — the issue/PR the event is about.
  number?: number;
  // Trusted references synthesized by LoopHub for a GitHub feedback event. Comment bodies are
  // intentionally absent from this shape and can never be interpolated into the injected line.
  githubPr?: string;
  feedbackRefs?: Array<{ kind: string; id: number; reference: string }>;
}

// The injected line must stay a single line of space-separated key=value tokens: repo full_name is
// not charset-validated at creation, and the line is typed into a live pane, so a name carrying
// whitespace or control characters (Unicode Cc — C0, DEL, and C1 such as NEL, which some terminals
// treat as a line break) must not be able to add extra lines or tokens to what the worker types.
// That is the whole guarantee — printable characters, CJK names included, pass through unchanged.
function tokenize(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, "_");
}

// The single line injected into the subscriber's pane via `herdr pane run`. An idle claude/codex
// pane processes injected text as a normal user turn, so this is written as an instruction — but a
// deliberately generic one: the worker states what happened and nothing about what to do, because
// the "what to do" wiring belongs to the subscriber (its skill/prompt), not the worker.
export function buildNotifyText(input: NotifyTextInput): string {
  const number = input.number !== undefined ? ` number=${input.number}` : "";
  if (input.githubPr && input.feedbackRefs && input.feedbackRefs.length > 0) {
    const refs = input.feedbackRefs
      .map(
        (item) =>
          `${tokenize(item.kind)}:${item.id}:${tokenize(item.reference)}`,
      )
      .join(",");
    return (
      `LoopHub event: type=${tokenize(input.eventType)} repo=${tokenize(input.repoFullName)}` +
      `${number} event_id=${input.eventId} github_pr=${tokenize(input.githubPr)} feedback=${refs}. ` +
      "GitHub PR feedback was added or updated; review the referenced feedback and decide whether the Workflow needs action."
    );
  }
  if (input.eventType === "workflow_run.turn_done") {
    return (
      `LoopHub event: type=${tokenize(input.eventType)} repo=${tokenize(input.repoFullName)}` +
      `${number} event_id=${input.eventId}. ` +
      "The Execute child declared its turn done. Observe the run state (`lh workflow step status`) before deciding any transition."
    );
  }
  if (input.eventType === "workflow_run.escalated") {
    return (
      `LoopHub event: type=${tokenize(input.eventType)} repo=${tokenize(input.repoFullName)}` +
      `${number} event_id=${input.eventId}. ` +
      "The Execute child requested human guidance. Read this event from domain state, then follow the Workflow escalation contract."
    );
  }
  if (input.eventType === "workflow_run.review_submitted") {
    return (
      `LoopHub event: type=${tokenize(input.eventType)} repo=${tokenize(input.repoFullName)}` +
      `${number} event_id=${input.eventId}. ` +
      "The Verify child registered a workflow review. Observe the run state (`lh workflow step status`) before deciding any transition."
    );
  }
  return (
    `LoopHub event: type=${tokenize(input.eventType)} repo=${tokenize(input.repoFullName)}` +
    `${number} event_id=${input.eventId}. ` +
    "You subscribed to this event via `lh subscribe`; handle it according to your own instructions."
  );
}
