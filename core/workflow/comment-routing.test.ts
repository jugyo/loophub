import { describe, expect, test } from "vitest";
import { workflowCommentTargets } from "./comment-routing.ts";

describe("workflowCommentTargets", () => {
  test("maps supported mentions to workflow agents", () => {
    expect(workflowCommentTargets(["Please check this, @executor."])).toEqual([
      "executor",
    ]);
    expect(workflowCommentTargets(["Could @verifier confirm this?"])).toEqual([
      "verifier",
    ]);
    expect(
      workflowCommentTargets(["@loophub please coordinate this."]),
    ).toEqual(["orchestrator"]);
    expect(workflowCommentTargets(["@lh please coordinate this."])).toEqual([
      "orchestrator",
    ]);
  });

  test("preserves first-mention order and removes duplicate targets", () => {
    expect(
      workflowCommentTargets([
        "@verifier and @lh should check this.",
        "@loophub, @verifier, and @executor too.",
      ]),
    ).toEqual(["verifier", "orchestrator", "executor"]);
  });

  test("defaults to Execute when no exact supported mention exists", () => {
    expect(
      workflowCommentTargets([
        "No explicit target; @executor-helper and mail@verifier are unrelated.",
      ]),
    ).toEqual(["executor"]);
  });
});
