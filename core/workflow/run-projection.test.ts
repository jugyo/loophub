import { expect, test } from "vitest";
import {
  projectWorkflowRunEvents,
  type WorkflowRunEventRow,
  workflowStepPhaseAt,
} from "./run-projection.ts";

let nextId = 0;

function row(type: string, payload: unknown): WorkflowRunEventRow {
  nextId += 1;
  return {
    id: nextId,
    type,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    created_at: `2026-01-01T00:00:${String(nextId).padStart(2, "0")}Z`,
  };
}

test("turn done, verify launch and execute round resolve to the latest of each", () => {
  const trail = [
    row("workflow_step.launched", { id: 1, step: "execute" }),
    row("workflow_run.turn_done", { id: 1, head_sha: "aaa" }),
    row("workflow_step.launched", { id: 1, step: "verify" }),
    row("workflow_run.turn_done", { id: 1, head_sha: "bbb" }),
    row("workflow_run.updated", {
      id: 1,
      transition: "activate_step",
      active_step: "execute",
    }),
  ];
  const projection = projectWorkflowRunEvents(trail);

  expect(projection.events).toHaveLength(5);
  expect(projection.turnDones.map((event) => event.payload.head_sha)).toEqual([
    "aaa",
    "bbb",
  ]);
  expect(projection.latestTurnDone?.payload.head_sha).toBe("bbb");
  expect(projection.latestVerifyLaunch?.id).toBe(trail[2].id);
  // The `activate_step` reactivation counts as an Execute round, not just a fresh launch.
  expect(projection.latestExecuteRound?.id).toBe(trail[4].id);
});

// Discarding stale verifiers needs every Verify child a run has launched, not only the newest —
// a run can have more than one alive at once (#1857).
test("every verify launch is kept, oldest first, with the latest also exposed alone", () => {
  const trail = [
    row("workflow_step.launched", { id: 1, step: "verify", head_sha: "aaa" }),
    row("workflow_step.launched", { id: 1, step: "execute", head_sha: null }),
    row("workflow_step.launched", { id: 1, step: "verify", head_sha: "bbb" }),
  ];
  const projection = projectWorkflowRunEvents(trail);

  expect(projection.verifyLaunches.map((event) => event.id)).toEqual([
    trail[0].id,
    trail[2].id,
  ]);
  expect(projection.latestVerifyLaunch?.id).toBe(trail[2].id);
});

test("a review's first and latest submission are kept apart", () => {
  const trail = [
    row("workflow_run.review_submitted", {
      id: 1,
      review_id: 7,
      submission_head_sha: "aaa",
    }),
    row("workflow_run.review_submitted", { id: 1, review_id: 8 }),
    row("workflow_run.review_submitted", {
      id: 1,
      review_id: 7,
      submission_head_sha: "bbb",
    }),
  ];
  const projection = projectWorkflowRunEvents(trail);

  const seven = projection.reviewSubmissions.get(7);
  expect(seven?.first.payload.submission_head_sha).toBe("aaa");
  expect(seven?.latest.payload.submission_head_sha).toBe("bbb");
  expect(projection.reviewSubmissions.get(8)?.first.id).toBe(trail[1].id);
  expect(projection.reviewSubmissions.get(9)).toBeUndefined();
});

test("comment deliveries remain pending until their completion event", () => {
  const trail = [
    row("workflow_run.delivery_queued", {
      id: 1,
      delivery_id: "first",
      target: "verifier",
      text: "first instruction",
    }),
    row("workflow_run.delivery_queued", {
      id: 1,
      delivery_id: "second",
      target: "executor",
      text: "second instruction",
    }),
    row("workflow_run.delivery_completed", {
      id: 1,
      delivery_id: "first",
      target: "verifier",
    }),
  ];

  expect(projectWorkflowRunEvents(trail).pendingDeliveries).toEqual([
    { id: "second", target: "executor", text: "second instruction" },
  ]);
});

test("phase follows current_step and ignores an activate_step reactivation (#1873)", () => {
  const trail = [
    row("workflow_run.started", { id: 1 }),
    row("workflow_run.updated", {
      id: 1,
      transition: "advance_to_verify",
      current_step: "verify",
    }),
    row("workflow_run.updated", {
      id: 1,
      transition: "activate_step",
      current_step: "verify",
      active_step: "execute",
    }),
    row("workflow_run.review_submitted", { id: 1, review_id: 3 }),
  ];
  const projection = projectWorkflowRunEvents(trail);

  // A run starts in Execute, so anything recorded before the first transition reads as Execute.
  expect(workflowStepPhaseAt(projection, trail[0].id)).toBe("execute");
  expect(workflowStepPhaseAt(projection, trail[1].id)).toBe("verify");
  expect(workflowStepPhaseAt(projection, trail[3].id)).toBe("verify");
});

test("payloads written before the typed shape existed keep their fallbacks", () => {
  const trail = [
    // A row whose payload is not an object at all, and one that is not JSON.
    row("workflow_run.turn_done", "not json"),
    row("workflow_run.turn_done", 42),
    // Legacy launches and updates that predate the keys the projection reads.
    row("workflow_step.launched", { id: 1 }),
    row("workflow_run.updated", { id: 1, current_step: "plan" }),
    row("workflow_run.review_submitted", { id: 1 }),
    // An unknown key alongside a known one is carried without disturbing the known one.
    row("workflow_run.turn_done", {
      id: 1,
      head_sha: "ccc",
      teleport_id: "nope",
    }),
  ];
  const projection = projectWorkflowRunEvents(trail);

  expect(projection.events[0].payload).toEqual({});
  expect(projection.events[1].payload).toEqual({});
  // A launch without `step` starts no round, an update with an unrecognized `current_step` moves no
  // phase, and a submission without `review_id` is not indexed.
  expect(projection.verifyLaunches).toEqual([]);
  expect(projection.latestVerifyLaunch).toBeNull();
  expect(projection.latestExecuteRound).toBeNull();
  expect(projection.phaseTransitions).toEqual([]);
  expect(workflowStepPhaseAt(projection, trail[3].id)).toBe("execute");
  expect(projection.reviewSubmissions.size).toBe(0);
  // Malformed rows still count as turn dones — they are the run's record that a turn was declared.
  expect(projection.turnDones).toHaveLength(3);
  expect(projection.latestTurnDone?.payload.head_sha).toBe("ccc");
});
