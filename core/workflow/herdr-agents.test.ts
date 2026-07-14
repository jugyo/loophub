import { describe, expect, test } from "vitest";
import {
  nextWorkflowChildSequence,
  parseLegacyWorkflowParentHerdrAgentName,
  parseLegacyWorkflowStepHerdrAgentName,
  parseWorkflowHerdrAgentName,
  workflowHerdrPaneKind,
  workflowParentHerdrAgentName,
  workflowStepHerdrAgentName,
  workflowStepSessionIds,
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

  test("recognizes legacy parent names", () => {
    expect(parseLegacyWorkflowParentHerdrAgentName("workflow-a1b2c3d4")).toBe(
      "a1b2c3d4",
    );
    expect(
      parseLegacyWorkflowParentHerdrAgentName("orchestrator #34"),
    ).toBeNull();
  });

  test("parses legacy step names for session compatibility", () => {
    expect(
      parseLegacyWorkflowStepHerdrAgentName("workflow execute #34"),
    ).toEqual({
      kind: "step",
      runId: 34,
      step: "execute",
    });
    expect(
      parseLegacyWorkflowStepHerdrAgentName("workflow verify #34"),
    ).toEqual({
      kind: "step",
      runId: 34,
      step: "verify",
    });
    expect(
      parseLegacyWorkflowStepHerdrAgentName("Workflow execute run #34"),
    ).toEqual({
      kind: "step",
      runId: 34,
      step: "execute",
    });
    expect(parseLegacyWorkflowStepHerdrAgentName("verifier #34-2")).toBeNull();
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

  test("returns the persisted session ids for one step", () => {
    const history = JSON.stringify({
      execute: ["execute-1", "execute-3"],
      verify: ["verify-2"],
    });
    expect(workflowStepSessionIds(history, "execute")).toEqual([
      "execute-1",
      "execute-3",
    ]);
    expect(workflowStepSessionIds(history, "verify")).toEqual(["verify-2"]);
  });

  test("reads step session ids defensively for terminal display", () => {
    expect(workflowStepSessionIds("not json", "execute")).toEqual([]);
    expect(
      workflowStepSessionIds('{"execute":["execute-1",42]}', "execute"),
    ).toEqual(["execute-1"]);
    expect(nextWorkflowChildSequence('{"execute":[],"legacy":"ignored"}')).toBe(
      1,
    );
  });

  test.each([
    "not json",
    "[]",
    '{"execute":"not an array"}',
    '{"execute":[42]}',
  ])("rejects invalid launch history: %s", (history) => {
    expect(() => nextWorkflowChildSequence(history)).toThrow(
      "invalid Workflow step session history",
    );
  });
});
