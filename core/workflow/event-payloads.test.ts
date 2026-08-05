import { expect, test } from "vitest";
import { parseWorkflowEventPayload } from "./event-payloads.ts";

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
