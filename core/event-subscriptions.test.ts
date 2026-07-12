import { expect, test } from "vitest";
import { buildNotifyText, notifiableEventType } from "./event-subscriptions.ts";

test("notifiableEventType excludes the pub/sub audit namespace", () => {
  expect(notifiableEventType("pull_request.merge_conflict")).toBe(true);
  expect(notifiableEventType("issue.opened")).toBe(true);
  // Subscribing to the notify audit event must never produce another notify (infinite loop).
  expect(notifiableEventType("event_subscription.notified")).toBe(false);
  expect(notifiableEventType("event_subscription.anything")).toBe(false);
});

test("buildNotifyText is one line naming the event, not an action", () => {
  const text = buildNotifyText({
    eventType: "pull_request.merge_conflict",
    repoFullName: "me/proj",
    eventId: 42,
    number: 7,
  });
  expect(text).toContain("type=pull_request.merge_conflict");
  expect(text).toContain("repo=me/proj");
  expect(text).toContain("number=7");
  expect(text).toContain("event_id=42");
  expect(text).not.toContain("\n");
});

test("buildNotifyText omits number when the payload has none", () => {
  const text = buildNotifyText({
    eventType: "issue.closed",
    repoFullName: "me/proj",
    eventId: 43,
  });
  expect(text).not.toContain("number=");
  expect(text).toContain("event_id=43");
});

test("buildNotifyText folds control characters and whitespace into single tokens", () => {
  // repo full_name is not charset-validated at creation; a hostile name must not be able to add
  // lines or extra tokens to what the worker types into a pane.
  const text = buildNotifyText({
    eventType: "issue.opened",
    repoFullName: "me/x;\nrm -rf y\ttail",
    eventId: 44,
  });
  expect(text).not.toContain("\n");
  expect(text).toContain("repo=me/x;_rm_-rf_y_tail");
  // C1 controls (e.g. NEL U+0085) are line breaks on some terminals — folded like C0.
  expect(
    buildNotifyText({
      eventType: "issue.opened",
      repoFullName: "me/ab",
      eventId: 45,
    }),
  ).toContain("repo=me/a_b");
});
