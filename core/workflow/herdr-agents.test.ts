import { describe, expect, test } from "vitest";
import {
  nextWorkflowChildSequence,
  parseWorkflowHerdrAgentName,
  workflowHerdrPaneKind,
  workflowParentHerdrAgentName,
  workflowStepHerdrAgentName,
} from "./herdr-agents.ts";

describe("Workflow Herdr agent names", () => {
  test("generates and parses the parent name", () => {
    expect(workflowParentHerdrAgentName(34)).toBe("orchestrator #34");
    expect(parseWorkflowHerdrAgentName("orchestrator #34")).toEqual({
      kind: "parent",
      runId: 34,
    });
  });

  test.each([
    ["execute", 1, "executor #34-1"],
    ["verify", 2, "verifier #34-2"],
  ] as const)("generates and parses the %s child name", (step, sequence, name) => {
    expect(workflowStepHerdrAgentName(34, step, sequence)).toBe(name);
    expect(parseWorkflowHerdrAgentName(name)).toEqual({
      kind: "step",
      runId: 34,
      step,
      sequence,
    });
  });

  test("rejects legacy, malformed, and unrelated names", () => {
    expect(parseWorkflowHerdrAgentName("workflow-a1b2c3d4")).toBeNull();
    expect(parseWorkflowHerdrAgentName("workflow execute #34")).toBeNull();
    expect(parseWorkflowHerdrAgentName("executor #34-0")).toBeNull();
    expect(parseWorkflowHerdrAgentName("dev #34")).toBeNull();
  });

  test("recognizes legacy panes only for layout compatibility", () => {
    expect(workflowHerdrPaneKind("workflow-a1b2c3d4", 34)).toBe("parent");
    expect(workflowHerdrPaneKind("workflow execute #34", 34)).toBe("step");
    expect(workflowHerdrPaneKind("workflow verify #35", 34)).toBeNull();
  });

  test("increments one sequence across Execute and Verify launch histories", () => {
    expect(nextWorkflowChildSequence("{}")).toBe(1);
    expect(
      nextWorkflowChildSequence(
        JSON.stringify({
          execute: ["execute-1", "execute-3"],
          verify: ["verify-2"],
        }),
      ),
    ).toBe(4);
  });

  test.each([
    "not json",
    "[]",
    '{"execute":"not an array"}',
  ])("rejects invalid launch history: %s", (history) => {
    expect(() => nextWorkflowChildSequence(history)).toThrow(
      "invalid Workflow step session history",
    );
  });
});
