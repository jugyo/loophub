import { describe, expect, it } from "#loophub-test";
import { CODING_AGENTS, RUNTIMES } from "../../../core/runtimes.ts";
import {
  CODING_AGENT_LABELS,
  EFFORT_SUGGESTIONS,
  effortSuggestionsForModel,
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

  it("offers the Codex effort levels per model (#522)", () => {
    expect(MODEL_SUGGESTIONS.codex[0]).toBe("gpt-6-astra");
    expect(effortSuggestionsForModel("codex", "gpt-6-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortSuggestionsForModel("codex", "gpt-5.6-sol")).toEqual(
      EFFORT_SUGGESTIONS.codex,
    );
  });

  it("exposes OpenCode with its registry label and empty effort suggestions", () => {
    expect(CODING_AGENT_LABELS.opencode).toBe("OpenCode");
    expect(MODEL_SUGGESTIONS.opencode).toContain("opencode/big-pickle");
    // Interactive TUI has no --variant; Settings/pickers hide the effort ladder.
    expect(EFFORT_SUGGESTIONS.opencode).toEqual([]);
  });
});
