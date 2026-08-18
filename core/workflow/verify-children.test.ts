import { expect, test } from "vitest";
import {
  projectWorkflowRunEvents,
  type WorkflowRunEventRow,
} from "./run-projection.ts";
import { priorVerifyChildSessions } from "./verify-children.ts";

let nextId = 0;

function launch(payload: unknown): WorkflowRunEventRow {
  nextId += 1;
  return {
    id: nextId,
    type: "workflow_step.launched",
    payload: JSON.stringify(payload),
    created_at: `2026-01-01T00:00:${String(nextId).padStart(2, "0")}Z`,
  };
}

test("every prior verify child is superseded regardless of head", () => {
  const launches = projectWorkflowRunEvents([
    launch({ id: 1, step: "verify", session_id: "same-head", head_sha: "bbb" }),
    launch({ id: 1, step: "execute", session_id: "exec", head_sha: null }),
    launch({ id: 1, step: "verify", session_id: "old-head", head_sha: "aaa" }),
    launch({ id: 1, step: "verify", session_id: "same-head", head_sha: "bbb" }),
  ]).verifyLaunches;

  expect(priorVerifyChildSessions(launches)).toEqual(["same-head", "old-head"]);
});

test("a legacy launch without a head is selected when its session is known", () => {
  const launches = projectWorkflowRunEvents([
    launch({ id: 1, step: "verify", session_id: "legacy" }),
    launch({ id: 1, step: "verify", session_id: "" }),
    launch({ id: 1, step: "verify", session_id: null }),
  ]).verifyLaunches;

  expect(priorVerifyChildSessions(launches)).toEqual(["legacy"]);
});
