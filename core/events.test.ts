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
