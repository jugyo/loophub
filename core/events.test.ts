import { expect, test } from "vitest";
import { formatEvent } from "./events.ts";

test("formatEvent parses the payload, normalizes its subjects, and attaches repo full_name", () => {
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
    subjects: [{ kind: "issue", number: 3 }],
    created_at: "2026-01-01T00:00:00Z",
  });
});

test("formatEvent leaves subjects empty for a payload that names nothing", () => {
  const ev = formatEvent({
    id: 8,
    type: "issue.opened",
    actor: "me",
    payload: "null",
    created_at: "2026-01-01T00:00:00Z",
    repo_id: null,
  });
  expect(ev.payload).toBeNull();
  expect(ev.subjects).toEqual([]);
});
