import { expect, test, vi } from "vitest";
import type { LoopEvent } from "../events.ts";
import { workflowWatch } from "./workflow-watch.ts";

const INPUT = { repo: "jugyo/loophub", run: 42, since: 0 };

const EVENT = {
  id: 8,
  type: "workflow_run.turn_done",
  repo: "jugyo/loophub",
  actor: "executor",
  payload: { id: 42 },
  created_at: "2026-07-21T00:00:00Z",
} satisfies LoopEvent;

function createDeps(events: LoopEvent[][]) {
  return {
    readEvents: vi.fn().mockImplementation(() => events.shift() ?? []),
    wait: vi.fn(),
    log: vi.fn(),
  };
}

test("blocks until an event exists and returns the oldest one", async () => {
  const deps = createDeps([[], [EVENT]]);

  const event = await workflowWatch.waitForEvent(INPUT, deps);

  expect(deps.readEvents).toHaveBeenNthCalledWith(1, {
    since: 0,
    repo: "jugyo/loophub",
    types: ["workflow_run"],
    runId: 42,
    order: "asc",
    limit: 1,
  });
  expect(deps.wait).toHaveBeenCalledTimes(1);
  expect(event).toEqual(EVENT);
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "started", cursor: 0 }),
  );
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "poll", cursor: 0 }),
  );
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "delivered", cursor: 8 }),
  );
});

test("returns an event recorded after the cursor without waiting", async () => {
  const transition = { ...EVENT, id: 11, type: "workflow_run.updated" };
  const deps = createDeps([[transition]]);

  const event = await workflowWatch.waitForEvent({ ...INPUT, since: 8 }, deps);

  expect(deps.wait).not.toHaveBeenCalled();
  expect(deps.readEvents).toHaveBeenLastCalledWith(
    expect.objectContaining({ since: 8 }),
  );
  expect(event).toEqual(transition);
});

test.each([
  ["event read", "read failed", "readEvents"],
  ["wait", "wait failed", "wait"],
] as const)("surfaces a %s failure and stops", async (_name, message, failingDep) => {
  const deps = createDeps([[]]);
  deps[failingDep].mockRejectedValue(new Error("command failed"));

  await expect(workflowWatch.waitForEvent(INPUT, deps)).rejects.toThrow(
    message,
  );
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "failed", error: "command failed" }),
  );
});
