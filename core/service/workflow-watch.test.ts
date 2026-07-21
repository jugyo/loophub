import { describe, expect, test, vi } from "vitest";
import type { LoopEvent } from "../events.ts";
import { parseWorkflowWatchArgs, workflowWatch } from "./workflow-watch.ts";

const VALID_ARGS = ["--repo", "jugyo/loophub", "--run", "42", "--json"];
const INPUT = parseWorkflowWatchArgs(VALID_ARGS);

const EVENT = {
  id: 8,
  type: "workflow_run.turn_done",
  repo: "jugyo/loophub",
  actor: "executor",
  payload: { id: 42 },
  created_at: "2026-07-21T00:00:00Z",
} satisfies LoopEvent;

function createDeps(events: LoopEvent[][]) {
  let run = {
    id: 42,
    repo_id: 1,
    event_ack_cursor: 0,
    event_delivered_cursor: 0,
  };
  return {
    getRepo: vi.fn(() => ({ id: 1 })),
    getRun: vi.fn(() => ({ ...run })),
    acknowledge: vi.fn((_id: number, cursor: number) => {
      if (cursor !== run.event_delivered_cursor) return null;
      run = { ...run, event_ack_cursor: cursor };
      return { ...run };
    }),
    recordDelivery: vi.fn((_id: number, cursor: number) => {
      run = { ...run, event_delivered_cursor: cursor };
      return { ...run };
    }),
    readEvents: vi.fn().mockImplementation(() => events.shift() ?? []),
    wait: vi.fn(),
  };
}

describe("parseWorkflowWatchArgs", () => {
  test("parses the run and optional acknowledgement", () => {
    expect(INPUT).toEqual({ repo: "jugyo/loophub", run: 42 });
    expect(parseWorkflowWatchArgs([...VALID_ARGS, "--ack", "7"])).toEqual({
      repo: "jugyo/loophub",
      run: 42,
      ack: 7,
    });
  });

  test.each([
    ["missing all options", []],
    ["unknown option", [...VALID_ARGS, "--runtime", "codex"]],
    ["unexpected positional", [...VALID_ARGS, "extra"]],
    ["duplicate option", [...VALID_ARGS, "--run", "43"]],
    ["missing option value", ["--repo", "--run", "42"]],
    ["repo without slash", ["--repo", "loophub", "--run", "42"]],
    ["repo with extra slash", ["--repo", "a/b/c", "--run", "42"]],
    ["repo with invalid segment", ["--repo", "a/..", "--run", "42"]],
    ["repo beginning with hyphen", ["--repo", "-a/b", "--run", "42"]],
    ["non-positive run", ["--repo", "a/b", "--run", "0"]],
    ["non-decimal run", ["--repo", "a/b", "--run", "1x"]],
    ["unsafe run", ["--repo", "a/b", "--run", "9007199254740992"]],
    ["negative ack", [...VALID_ARGS, "--ack", "-1"]],
  ])("rejects %s", (_name, args) => {
    expect(() => parseWorkflowWatchArgs(args)).toThrow("workflow watch:");
  });
});

test("blocks until an event exists and returns an event-sized ascending batch with cursor metadata", async () => {
  const deps = createDeps([[], [EVENT]]);

  const result = await workflowWatch.watch(INPUT, deps);

  expect(deps.readEvents).toHaveBeenNthCalledWith(1, {
    since: 0,
    repo: "jugyo/loophub",
    types: ["workflow_run"],
    runId: 42,
    order: "asc",
    limit: 1,
  });
  expect(deps.wait).toHaveBeenCalledTimes(1);
  expect(deps.recordDelivery).toHaveBeenCalledWith(42, 8);
  expect(result).toEqual({
    run: 42,
    events: [EVENT],
    cursor: { acknowledged: 0, delivered: 8 },
  });
});

test("replays an unacknowledged batch after the parent stops", async () => {
  const deps = createDeps([[EVENT], [EVENT]]);

  await workflowWatch.watch(INPUT, deps);
  const replay = await workflowWatch.watch(INPUT, deps);

  expect(replay.events).toEqual([EVENT]);
  expect(deps.readEvents).toHaveBeenLastCalledWith(
    expect.objectContaining({ since: 0 }),
  );
});

test("acknowledges only the delivered cursor before returning a newly available transition event", async () => {
  const transition = { ...EVENT, id: 11, type: "workflow_run.updated" };
  const deps = createDeps([[EVENT], [transition]]);
  await workflowWatch.watch(INPUT, deps);

  const result = await workflowWatch.watch({ ...INPUT, ack: 8 }, deps);

  expect(deps.acknowledge).toHaveBeenCalledWith(42, 8);
  expect(deps.wait).not.toHaveBeenCalled();
  expect(deps.readEvents).toHaveBeenLastCalledWith(
    expect.objectContaining({ since: 8 }),
  );
  expect(result.events).toEqual([transition]);
  expect(result.cursor).toEqual({ acknowledged: 8, delivered: 11 });
});

test("an event-level acknowledgement prevents a processed event from replaying after a stop between events", async () => {
  const next = { ...EVENT, id: 9, type: "workflow_run.review_submitted" };
  const deps = createDeps([[EVENT], [next], [next]]);

  await workflowWatch.watch(INPUT, deps);
  const afterCheckpoint = await workflowWatch.watch(
    { ...INPUT, ack: EVENT.id },
    deps,
  );
  const replayAfterStop = await workflowWatch.watch(INPUT, deps);

  expect(afterCheckpoint.events).toEqual([next]);
  expect(replayAfterStop.events).toEqual([next]);
  expect(replayAfterStop.events).not.toContainEqual(EVENT);
});

test("rejects an acknowledgement beyond the last delivered batch", async () => {
  const deps = createDeps([[EVENT]]);
  await workflowWatch.watch(INPUT, deps);

  await expect(workflowWatch.watch({ ...INPUT, ack: 9 }, deps)).rejects.toThrow(
    "cannot acknowledge cursor 9; expected 8",
  );
});

test.each([
  ["event read", "event read failed", "readEvents"],
  ["wait", "wait failed", "wait"],
] as const)("surfaces a %s failure and stops", async (_name, message, failingDep) => {
  const deps = createDeps([[]]);
  deps[failingDep].mockRejectedValue(new Error("command failed"));

  await expect(workflowWatch.watch(INPUT, deps)).rejects.toThrow(message);
});
