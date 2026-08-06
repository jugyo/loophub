import { describe, expect, it } from "vitest";
import { CODING_AGENTS, RUNTIMES } from "../../../core/runtimes.ts";
import {
  CODING_AGENT_LABELS,
  EFFORT_SUGGESTIONS,
  MODEL_SUGGESTIONS,
} from "./agent-models";

describe("agent-models", () => {
  it("derives labels and suggestions from the runtime registry for every agent", () => {
    expect(Object.keys(CODING_AGENT_LABELS)).toEqual([...CODING_AGENTS]);
    for (const agent of CODING_AGENTS) {
      expect(CODING_AGENT_LABELS[agent]).toBe(RUNTIMES[agent].label);
      expect(MODEL_SUGGESTIONS[agent]).toEqual(
        RUNTIMES[agent].modelSuggestions,
      );
      expect(EFFORT_SUGGESTIONS[agent]).toEqual(
        RUNTIMES[agent].effortSuggestions,
      );
    }
  });

  it("exposes OpenCode with its registry label and model/effort suggestions", () => {
    expect(CODING_AGENT_LABELS.opencode).toBe("OpenCode");
    expect(MODEL_SUGGESTIONS.opencode).toContain("opencode/big-pickle");
    expect(EFFORT_SUGGESTIONS.opencode).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });
});
