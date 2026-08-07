import { expect, test } from "vitest";
import {
  projectWorkflowRunEvents,
  type WorkflowRunEventRow,
} from "./run-projection.ts";
import { staleVerifyChildSessions } from "./stale-verify.ts";

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

function verifyLaunches(rows: WorkflowRunEventRow[]) {
  return projectWorkflowRunEvents(rows).verifyLaunches;
}

test("a verify child launched for an older head is stale, the one on the current head is not", () => {
  const launches = verifyLaunches([
    launch({ id: 1, step: "verify", session_id: "old", head_sha: "aaa" }),
    launch({ id: 1, step: "execute", session_id: "exec", head_sha: null }),
    launch({ id: 1, step: "verify", session_id: "fresh", head_sha: "bbb" }),
  ]);

  // Only the child pinned to a head the run has moved past — the Execute child never enters this
  // set at all, since the projection keeps Verify launches only.
  expect(staleVerifyChildSessions(launches, "bbb")).toEqual(["old"]);
});

test("every verify child launched for an older head is stale, oldest launch first", () => {
  const launches = verifyLaunches([
    launch({ id: 1, step: "verify", session_id: "first", head_sha: "aaa" }),
    launch({ id: 1, step: "verify", session_id: "second", head_sha: "bbb" }),
  ]);

  expect(staleVerifyChildSessions(launches, "ccc")).toEqual([
    "first",
    "second",
  ]);
});

// Not knowing which head a verifier is on is not the same as knowing it is on an old one: killing
// on a guess would take out the verifier the run is waiting for.
test("a launch with no recorded head, and an unresolvable HEAD, discard nothing", () => {
  const withoutHead = verifyLaunches([
    launch({ id: 1, step: "verify", session_id: "unknown-head" }),
    launch({ id: 1, step: "verify", session_id: "null-head", head_sha: null }),
  ]);
  expect(staleVerifyChildSessions(withoutHead, "bbb")).toEqual([]);

  const stale = verifyLaunches([
    launch({ id: 1, step: "verify", session_id: "old", head_sha: "aaa" }),
  ]);
  expect(staleVerifyChildSessions(stale, null)).toEqual([]);
});

test("a session relaunched onto the current head is judged by its newest launch", () => {
  const launches = verifyLaunches([
    launch({ id: 1, step: "verify", session_id: "child", head_sha: "aaa" }),
    launch({ id: 1, step: "verify", session_id: "child", head_sha: "bbb" }),
  ]);

  expect(staleVerifyChildSessions(launches, "bbb")).toEqual([]);
  expect(staleVerifyChildSessions(launches, "ccc")).toEqual(["child"]);
});
