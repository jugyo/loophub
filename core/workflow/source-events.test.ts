import { expect, test } from "vitest";
import {
  classifyWorkflowSubjectEvent,
  isWorkflowRunOwnSession,
  SOURCE_PAYLOAD_VERSION,
  type WorkflowTwinSourceRef,
  workflowSubscriptionLowerBound,
  workflowTwinSourceRef,
} from "./source-events.ts";

const NO_MARKED_SOURCE = () => false;
const MARKED_SOURCE = () => true;

test("a source written before the cutover only wakes state observation", () => {
  expect(
    classifyWorkflowSubjectEvent(
      { type: "pull_request.commented", payload: { comment_id: 5 } },
      NO_MARKED_SOURCE,
    ),
  ).toBe("wake_only");
});

test("its legacy twin is the one instruction that pair produces", () => {
  expect(
    classifyWorkflowSubjectEvent(
      {
        type: "workflow_run.pr_comment",
        payload: { source_event_id: 11, comment_id: 5 },
      },
      NO_MARKED_SOURCE,
    ),
  ).toBe("instruction");
});

test("a marked source carries its own instruction", () => {
  expect(
    classifyWorkflowSubjectEvent(
      {
        type: "pull_request.commented",
        payload: {
          comment_id: 5,
          source_payload_version: SOURCE_PAYLOAD_VERSION,
        },
      },
      NO_MARKED_SOURCE,
    ),
  ).toBe("instruction");
});

test("a twin that arrives late for a marked source is not a second instruction", () => {
  expect(
    classifyWorkflowSubjectEvent(
      { type: "workflow_run.pr_comment", payload: { source_event_id: 11 } },
      MARKED_SOURCE,
    ),
  ).toBe("superseded");
});

test("review twins name their source by the review both rows announce", () => {
  const twin = {
    type: "workflow_run.review_submitted",
    payload: { review_id: 9 },
  };

  expect(workflowTwinSourceRef(twin)).toEqual({ kind: "review", reviewId: 9 });
  expect(classifyWorkflowSubjectEvent(twin, MARKED_SOURCE)).toBe("superseded");
  expect(classifyWorkflowSubjectEvent(twin, NO_MARKED_SOURCE)).toBe(
    "instruction",
  );
});

test("the run's own lifecycle events are never twins", () => {
  const probe = (_ref: WorkflowTwinSourceRef): boolean => {
    throw new Error("a lifecycle event must not be probed for a source");
  };

  for (const type of [
    "workflow_run.turn_done",
    "workflow_run.escalated",
    "workflow_run.cost_exceeded",
    "workflow_step.launched",
  ]) {
    expect(
      classifyWorkflowSubjectEvent({ type, payload: { id: 3 } }, probe),
    ).toBe("instruction");
  }
});

test("an unrelated subject event without a marker wakes without instructing", () => {
  expect(
    classifyWorkflowSubjectEvent(
      { type: "issue.labeled", payload: { number: 4 } },
      NO_MARKED_SOURCE,
    ),
  ).toBe("wake_only");
});

test("the subscription starts at the run's own start, and never before it", () => {
  // Exclusive bound: the start itself is still selected, everything older than it is not.
  expect(workflowSubscriptionLowerBound(0, 120)).toBe(119);
  expect(workflowSubscriptionLowerBound(310, 120)).toBe(310);
});

test("a run recognises writes from its parent and from both of its children", () => {
  const run = {
    parent_session_id: "parent-session",
    step_sessions_json: JSON.stringify({
      execute: ["executor-session"],
      verify: ["verifier-session"],
    }),
  };

  expect(isWorkflowRunOwnSession(run, "parent-session")).toBe(true);
  expect(isWorkflowRunOwnSession(run, "executor-session")).toBe(true);
  expect(isWorkflowRunOwnSession(run, "verifier-session")).toBe(true);
  expect(isWorkflowRunOwnSession(run, "someone-else")).toBe(false);
  expect(isWorkflowRunOwnSession(run, null)).toBe(false);
});
