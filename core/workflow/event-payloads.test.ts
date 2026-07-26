import { expect, test } from "vitest";
import {
  parseWorkflowEventPayload,
  workflowEventPayloadOf,
  workflowGithubFeedbackReferences,
} from "./event-payloads.ts";

test("a payload column is parsed to an object, or rejected as null", () => {
  expect(parseWorkflowEventPayload('{"id":7,"step":"verify"}')).toEqual({
    id: 7,
    step: "verify",
  });
  // Keys the map does not declare stay readable; the payload is a record, not a schema check.
  expect(parseWorkflowEventPayload('{"id":7,"teleport":"x"}')).toEqual({
    id: 7,
    teleport: "x",
  });
  expect(parseWorkflowEventPayload("not json")).toBeNull();
  expect(parseWorkflowEventPayload("[1,2]")).toBeNull();
  expect(parseWorkflowEventPayload("null")).toBeNull();
  expect(parseWorkflowEventPayload("7")).toBeNull();
});

test("an already-parsed payload folds a non-object into an empty payload", () => {
  expect(workflowEventPayloadOf({ id: 7 })).toEqual({ id: 7 });
  expect(workflowEventPayloadOf(null)).toEqual({});
  expect(workflowEventPayloadOf(undefined)).toEqual({});
  expect(workflowEventPayloadOf([1, 2])).toEqual({});
  expect(workflowEventPayloadOf("x")).toEqual({});
});

test("GitHub feedback references drop items that carry no reference", () => {
  expect(
    workflowGithubFeedbackReferences({
      feedback: [
        {
          kind: "review",
          id: 1,
          updated_at: "2026-01-01T00:00:00Z",
          reference: "repos/o/r/pulls/1/reviews/1",
        },
      ],
    }),
  ).toEqual(["repos/o/r/pulls/1/reviews/1"]);
  // A payload with no feedback, or legacy items shaped differently, yields no references rather
  // than a partly-filled list the parent would try to read.
  expect(workflowGithubFeedbackReferences({})).toEqual([]);
  expect(
    workflowGithubFeedbackReferences(
      workflowEventPayloadOf({ feedback: [null, 3, { id: 1 }] }),
    ),
  ).toEqual([]);
});
