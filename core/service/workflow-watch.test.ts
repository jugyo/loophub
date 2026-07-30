import { expect, test, vi } from "vitest";
import type { EventRow, WorkflowRunRow } from "../store.ts";
import { workflowWatch } from "./workflow-watch.ts";

const RUN = {
  id: 42,
  repo_id: 3,
  issue_number: 7,
  pr_number: 8,
  event_cursor: 0,
} as WorkflowRunRow;

const INPUT = { repo: "jugyo/loophub", run: RUN, since: 0 };

const ROW = {
  id: 8,
  repo_id: 3,
  type: "workflow_run.turn_done",
  actor: "executor",
  payload: JSON.stringify({ id: 42 }),
  created_at: "2026-07-21T00:00:00Z",
} satisfies EventRow;

const STARTED_EVENT_ID = 4;
// The run's own start stays selectable, so the exclusive bound sits one id below it.
const STARTED_BOUND = STARTED_EVENT_ID - 1;

function createDeps(rows: (EventRow | null)[]) {
  return {
    startedEventId: vi.fn().mockReturnValue(STARTED_EVENT_ID),
    readNextEvent: vi.fn().mockImplementation(() => rows.shift() ?? null),
    wait: vi.fn(),
    log: vi.fn(),
  };
}

test("blocks until a subject event exists and returns the oldest one", async () => {
  const deps = createDeps([null, ROW]);

  const event = await workflowWatch.waitForEvent(INPUT, deps);

  expect(deps.readNextEvent).toHaveBeenNthCalledWith(1, {
    repoId: 3,
    runId: 42,
    issueNumber: 7,
    prNumber: 8,
    afterId: STARTED_BOUND,
  });
  expect(deps.wait).toHaveBeenCalledTimes(1);
  expect(event).toEqual({
    id: 8,
    type: "workflow_run.turn_done",
    repo: "jugyo/loophub",
    actor: "executor",
    payload: { id: 42 },
    created_at: "2026-07-21T00:00:00Z",
  });
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "started", cursor: 0 }),
  );
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "poll", cursor: STARTED_BOUND }),
  );
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "delivered", cursor: 8 }),
  );
});

test("returns an event recorded after the cursor without waiting", async () => {
  const transition = { ...ROW, id: 11, type: "workflow_run.updated" };
  const deps = createDeps([transition]);

  const event = await workflowWatch.waitForEvent({ ...INPUT, since: 9 }, deps);

  expect(deps.wait).not.toHaveBeenCalled();
  expect(deps.readNextEvent).toHaveBeenLastCalledWith(
    expect.objectContaining({ afterId: 9 }),
  );
  expect(event).toMatchObject({ id: 11, type: "workflow_run.updated" });
});

test("bounds the subscription below by the run's started event", async () => {
  const deps = createDeps([ROW]);

  await workflowWatch.waitForEvent({ ...INPUT, since: 1 }, deps);

  // The cursor predates the run's start, so the backlog its narrower subscription never had to
  // skip stays out of the selection.
  expect(deps.readNextEvent).toHaveBeenLastCalledWith(
    expect.objectContaining({ afterId: STARTED_BOUND }),
  );
});

test("surfaces a missing started event without selecting anything", async () => {
  const deps = createDeps([ROW]);
  deps.startedEventId.mockReturnValue(null);

  await expect(workflowWatch.waitForEvent(INPUT, deps)).rejects.toThrow(
    "run #42 has no workflow_run.started event",
  );
  expect(deps.readNextEvent).not.toHaveBeenCalled();
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "failed",
      error: "run #42 has no workflow_run.started event",
    }),
  );
});

test.each([
  ["event read", "read failed", "readNextEvent"],
  ["wait", "wait failed", "wait"],
] as const)("surfaces a %s failure and stops", async (_name, message, failingDep) => {
  const deps = createDeps([null]);
  deps[failingDep].mockRejectedValue(new Error("command failed"));

  await expect(workflowWatch.waitForEvent(INPUT, deps)).rejects.toThrow(
    message,
  );
  expect(deps.log).toHaveBeenCalledWith(
    expect.objectContaining({ event: "failed", error: "command failed" }),
  );
});
