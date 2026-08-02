import { expect, test } from "vitest";
import { formatEvent } from "./events.ts";

test("formatEvent parses the payload and attaches repo full_name", () => {
  const ev = formatEvent(
    {
      id: 7,
      type: "issue.opened",
      actor: "me",
      payload: JSON.stringify({ number: 3 }),
      created_at: "2026-01-01T00:00:00Z",
      repo_id: 1,
    },
    "me/proj",
  );
  expect(ev).toEqual({
    id: 7,
    type: "issue.opened",
    repo: "me/proj",
    actor: "me",
    payload: { number: 3 },
    created_at: "2026-01-01T00:00:00Z",
  });
});

test("formatEvent keeps historical event types after their producer is retired", () => {
  const ev = formatEvent({
    id: 8,
    type: "scheduled_task.created",
    actor: "me",
    payload: JSON.stringify({ id: 3, title: "Daily triage" }),
    created_at: "2026-01-02T00:00:00Z",
    repo_id: 1,
  });

  expect(ev.type).toBe("scheduled_task.created");
  expect(ev.payload).toEqual({ id: 3, title: "Daily triage" });
});
