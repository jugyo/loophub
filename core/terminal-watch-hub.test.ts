import { expect, test } from "vitest";
import { listenerCount, publish, subscribe } from "./terminal-watch-hub.ts";

test("subscribe delivers publish() calls until unsubscribed", () => {
  const before = listenerCount();
  let count = 0;
  const unsub = subscribe(() => {
    count++;
  });
  expect(listenerCount()).toBe(before + 1);

  publish();
  publish();
  expect(count).toBe(2);

  unsub();
  expect(listenerCount()).toBe(before);
  publish();
  expect(count).toBe(2); // nothing delivered after unsubscribe
});

test("a throwing listener does not break delivery to others", () => {
  let calls = 0;
  const unsubBad = subscribe(() => {
    throw new Error("boom");
  });
  const unsubGood = subscribe(() => {
    calls++;
  });
  publish();
  unsubBad();
  unsubGood();
  expect(calls).toBe(1);
});
