import { expect, test } from "#loophub-test";
import {
  projectWorkflowRunEvents,
  type WorkflowRunEventRow,
} from "./run-projection.ts";
import {
  latestVerifyClaimRelease,
  priorVerifyChildSessions,
  VERIFY_STALL_TIMEOUT_MS,
  verifyRunningForHead,
} from "./verify-children.ts";

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

function verifyLaunch(headSha: string, createdAt: string) {
  return projectWorkflowRunEvents([
    {
      id: 100,
      type: "workflow_step.launched",
      payload: JSON.stringify({
        id: 1,
        step: "verify",
        session_id: "verifier",
        head_sha: headSha,
      }),
      created_at: createdAt,
    },
  ]).latestVerifyLaunch;
}

const LAUNCHED_AT = "2026-01-01T00:00:00Z";
const RUNNING = Date.parse(LAUNCHED_AT) + 60_000;

test("a verify child launched for the current head is still reviewing it", () => {
  expect(
    verifyRunningForHead({
      launch: verifyLaunch("aaa", LAUNCHED_AT),
      latestReviewSubmissionId: null,
      claimRelease: null,
      currentHead: "aaa",
      now: RUNNING,
    }),
  ).toBe(true);
});

test("a verify child launched for an older head does not cover the current one", () => {
  expect(
    verifyRunningForHead({
      launch: verifyLaunch("aaa", LAUNCHED_AT),
      latestReviewSubmissionId: null,
      claimRelease: null,
      currentHead: "bbb",
      now: RUNNING,
    }),
  ).toBe(false);
});

test("a verify child that already submitted its review is no longer running", () => {
  expect(
    verifyRunningForHead({
      launch: verifyLaunch("aaa", LAUNCHED_AT),
      latestReviewSubmissionId: 101,
      claimRelease: null,
      currentHead: "aaa",
      now: RUNNING,
    }),
  ).toBe(false);
});

test("a verify child past the stall timeout stops holding its head (#1857)", () => {
  expect(
    verifyRunningForHead({
      launch: verifyLaunch("aaa", LAUNCHED_AT),
      latestReviewSubmissionId: null,
      claimRelease: null,
      currentHead: "aaa",
      now: Date.parse(LAUNCHED_AT) + VERIFY_STALL_TIMEOUT_MS + 1,
    }),
  ).toBe(false);
});

test("an Execute pane reactivated for live input leaves the verify child reviewing (#2528)", () => {
  const events = projectWorkflowRunEvents([
    {
      id: 100,
      type: "workflow_run.updated",
      payload: JSON.stringify({
        id: 1,
        transition: "activate_step",
        active_step: "execute",
      }),
      created_at: LAUNCHED_AT,
    },
  ]).events;

  expect(latestVerifyClaimRelease(events)).toBeNull();
});

test("a human hold releases the verify child's claim on its head (#1872)", () => {
  const events = projectWorkflowRunEvents([
    {
      id: 101,
      type: "workflow_run.updated",
      payload: JSON.stringify({ id: 1, transition: "await_human" }),
      created_at: LAUNCHED_AT,
    },
    {
      id: 102,
      type: "workflow_run.updated",
      payload: JSON.stringify({ id: 1, transition: "resume_after_human" }),
      created_at: LAUNCHED_AT,
    },
  ]).events;

  expect(latestVerifyClaimRelease(events)?.id).toBe(102);
  expect(
    verifyRunningForHead({
      launch: verifyLaunch("aaa", LAUNCHED_AT),
      latestReviewSubmissionId: null,
      claimRelease: latestVerifyClaimRelease(events),
      currentHead: "aaa",
      now: RUNNING,
    }),
  ).toBe(false);
});

test("a relaunch releases the lost verify child's claim on its head", () => {
  const events = projectWorkflowRunEvents([
    {
      id: 103,
      type: "workflow_run.updated",
      payload: JSON.stringify({ id: 1, transition: "relaunch" }),
      created_at: LAUNCHED_AT,
    },
  ]).events;

  expect(latestVerifyClaimRelease(events)?.id).toBe(103);
  expect(
    verifyRunningForHead({
      launch: verifyLaunch("aaa", LAUNCHED_AT),
      latestReviewSubmissionId: null,
      claimRelease: latestVerifyClaimRelease(events),
      currentHead: "aaa",
      now: RUNNING,
    }),
  ).toBe(false);
});
