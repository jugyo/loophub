import { test, expect } from "vitest";
import { formatEvent, subscribe, publishEvent, listenerCount } from "./event-hub.ts";

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

test("subscribe delivers published events until unsubscribed", () => {
  const before = listenerCount();
  const received: number[] = [];
  const unsub = subscribe((e) => received.push(e.id));
  expect(listenerCount()).toBe(before + 1);

  publishEvent(formatEvent({ id: 1, type: "x", actor: "me", payload: "{}", created_at: "" }));
  publishEvent(formatEvent({ id: 2, type: "x", actor: "me", payload: "{}", created_at: "" }));
  expect(received).toEqual([1, 2]);

  unsub();
  expect(listenerCount()).toBe(before);
  publishEvent(formatEvent({ id: 3, type: "x", actor: "me", payload: "{}", created_at: "" }));
  expect(received).toEqual([1, 2]);
});

test("a throwing listener does not break delivery to others", () => {
  const seen: number[] = [];
  const unsubBad = subscribe(() => {
    throw new Error("boom");
  });
  const unsubGood = subscribe((e) => seen.push(e.id));
  publishEvent(formatEvent({ id: 42, type: "x", actor: "me", payload: "{}", created_at: "" }));
  unsubBad();
  unsubGood();
  expect(seen).toEqual([42]);
});
