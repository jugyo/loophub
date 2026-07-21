import { describe, expect, test, vi } from "vitest";
import {
  parseWorkflowWatchArgs,
  WORKFLOW_WATCH_WAKE,
  workflowWatch,
} from "./workflow-watch.ts";

const VALID_ARGS = [
  "--repo",
  "jugyo/loophub",
  "--run",
  "42",
  "--since",
  "7",
  "--herdr-session",
  "session-1",
  "--parent-pane",
  "wS6:p2",
];

const INPUT = parseWorkflowWatchArgs(VALID_ARGS);

describe("parseWorkflowWatchArgs", () => {
  test("parses the complete watcher input", () => {
    expect(INPUT).toEqual({
      repo: "jugyo/loophub",
      run: 42,
      since: 7,
      herdrSession: "session-1",
      parentPane: "wS6:p2",
    });
  });

  test.each([
    ["missing all options", []],
    ["unknown option", [...VALID_ARGS, "--runtime", "codex"]],
    ["unexpected positional", [...VALID_ARGS, "extra"]],
    ["duplicate option", [...VALID_ARGS, "--run", "43"]],
    ["missing option value", ["--repo", "--run", "42"]],
    ["repo without slash", ["--repo", "loophub", ...VALID_ARGS.slice(2)]],
    ["repo with extra slash", ["--repo", "a/b/c", ...VALID_ARGS.slice(2)]],
    ["repo with invalid segment", ["--repo", "a/..", ...VALID_ARGS.slice(2)]],
    ["repo beginning with hyphen", ["--repo", "-a/b", ...VALID_ARGS.slice(2)]],
    [
      "non-positive run",
      [...VALID_ARGS.slice(0, 3), "0", ...VALID_ARGS.slice(4)],
    ],
    [
      "non-decimal run",
      [...VALID_ARGS.slice(0, 3), "1x", ...VALID_ARGS.slice(4)],
    ],
    [
      "unsafe run",
      [...VALID_ARGS.slice(0, 3), "9007199254740992", ...VALID_ARGS.slice(4)],
    ],
    [
      "negative cursor",
      [...VALID_ARGS.slice(0, 5), "-1", ...VALID_ARGS.slice(6)],
    ],
    [
      "invalid Herdr session",
      [...VALID_ARGS.slice(0, 7), "bad/session", ...VALID_ARGS.slice(8)],
    ],
    ["invalid parent pane", [...VALID_ARGS.slice(0, 9), "-pane"]],
  ])("rejects %s", (_name, args) => {
    expect(() => parseWorkflowWatchArgs(args)).toThrow("workflow watch:");
  });
});

test("polls with exact filters, waits while empty, wakes once, and exits", async () => {
  const readEvents = vi.fn().mockReturnValueOnce([]).mockReturnValueOnce([{}]);
  const wait = vi.fn();
  const deliver = vi.fn();

  await workflowWatch.watch(INPUT, { readEvents, wait, deliver });

  const query = {
    since: 7,
    repo: "jugyo/loophub",
    types: ["workflow_run"],
    runId: 42,
    order: "asc",
    limit: 1,
  };
  expect(readEvents).toHaveBeenNthCalledWith(1, query);
  expect(readEvents).toHaveBeenNthCalledWith(2, query);
  expect(wait).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledWith(INPUT, WORKFLOW_WATCH_WAKE);
});

test.each([
  ["event read", "event read failed", "readEvents"],
  ["wait", "wait failed", "wait"],
  ["Herdr delivery", "Herdr delivery failed", "deliver"],
] as const)("surfaces a %s failure and stops", async (_name, message, failingDep) => {
  const readEvents = vi.fn().mockReturnValue(failingDep === "wait" ? [] : [{}]);
  const wait = vi.fn();
  const deliver = vi.fn();
  const deps = { readEvents, wait, deliver };
  deps[failingDep].mockRejectedValue(new Error("command failed"));

  await expect(workflowWatch.watch(INPUT, deps)).rejects.toThrow(message);
  expect(readEvents).toHaveBeenCalledTimes(1);
  expect(wait).toHaveBeenCalledTimes(failingDep === "wait" ? 1 : 0);
  expect(deliver).toHaveBeenCalledTimes(failingDep === "deliver" ? 1 : 0);
});
