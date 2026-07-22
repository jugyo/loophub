import { describe, expect, test, vi } from "vitest";
import type { LoopEvent } from "../events.ts";
import { parseWorkflowWatchArgs, workflowWatch } from "./workflow-watch.ts";

const VALID_ARGS = [
  "--repo",
  "jugyo/loophub",
  "--run",
  "42",
  "--since",
  "0",
  "--json",
];
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
  return {
    getRepo: vi.fn(() => ({ id: 1 })),
    getRun: vi.fn(() => ({ id: 42, repo_id: 1 })),
    readEvents: vi.fn().mockImplementation(() => events.shift() ?? []),
    wait: vi.fn(),
    log: vi.fn(),
  };
}

describe("parseWorkflowWatchArgs", () => {
  test("parses the run and explicit in-memory cursor", () => {
    expect(INPUT).toEqual({ repo: "jugyo/loophub", run: 42, since: 0 });
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
    ["negative since", [...VALID_ARGS.slice(0, -3), "--since", "-1"]],
  ])("rejects %s", (_name, args) => {
    expect(() => parseWorkflowWatchArgs(args)).toThrow("workflow watch:");
  });
});

test("blocks until an event exists and returns one ascending event", async () => {
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
  expect(result).toEqual({
    run: 42,
    events: [EVENT],
    next_since: 8,
  });
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "started", cursor: 0 }),
  );
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "poll", cursor: 0 }),
  );
});

test("returns the next watch command with the delivered event id", async () => {
  const transition = { ...EVENT, id: 11, type: "workflow_run.updated" };
  const deps = createDeps([[transition]]);

  const result = await workflowWatch.watch({ ...INPUT, since: 8 }, deps);

  expect(deps.wait).not.toHaveBeenCalled();
  expect(deps.readEvents).toHaveBeenLastCalledWith(
    expect.objectContaining({ since: 8 }),
  );
  expect(result.events).toEqual([transition]);
  expect(result.next_since).toBe(11);
});

test("advances the cursor across multiple events without skipping one", async () => {
  const first = { ...EVENT, id: 12 };
  const second = { ...EVENT, id: 13 };
  const deps = createDeps([[first], [second]]);

  const firstResult = await workflowWatch.watch(INPUT, deps);
  const secondResult = await workflowWatch.watch(
    { ...INPUT, since: firstResult.next_since },
    deps,
  );

  expect(firstResult.events).toEqual([first]);
  expect(secondResult.events).toEqual([second]);
  expect(deps.readEvents).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ since: 12 }),
  );
  expect(secondResult.next_since).toBe(13);
});

test.each([
  ["event read", "event read failed", "readEvents"],
  ["wait", "wait failed", "wait"],
] as const)("surfaces a %s failure and stops", async (_name, message, failingDep) => {
  const deps = createDeps([[]]);
  deps[failingDep].mockRejectedValue(new Error("command failed"));

  await expect(workflowWatch.watch(INPUT, deps)).rejects.toThrow(message);
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "failed", error: "command failed" }),
  );
});
