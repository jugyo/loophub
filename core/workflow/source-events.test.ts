import { expect, test } from "vitest";
import { isWorkflowRunOwnSession } from "./source-events.ts";

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
