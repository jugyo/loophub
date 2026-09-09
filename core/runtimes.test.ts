import { expect, test } from "#loophub-test";
import {
  CODING_AGENTS,
  effortSuggestionsForModel,
  RUNTIMES,
} from "./runtimes.ts";

test("Claude Code suggests the fable model", () => {
  expect(RUNTIMES["claude-code"].modelSuggestions).toContain("claude-fable-5");
});

test("OpenCode suggests OpenCode Go models under opencode-go/* ids (#69)", () => {
  const suggestions = RUNTIMES.opencode.modelSuggestions;
  expect(suggestions).toContain("opencode-go/deepseek-v4-flash");
  expect(suggestions).toContain("opencode-go/kimi-k2.7-code");
  expect(suggestions).toContain("opencode-go/grok-4.5");
  // Existing non-OpenCode Go defaults stay selectable (#69).
  expect(suggestions).toContain("opencode/big-pickle");
  expect(suggestions).toContain("opencode/deepseek-v4-flash-free");
});

test("every runtime defines the auto-approve argv the launch paths append", () => {
  expect(RUNTIMES["claude-code"].autoApproveArgs).toEqual([
    "--permission-mode",
    "auto",
  ]);
  expect(RUNTIMES.codex.autoApproveArgs).toEqual([
    "--dangerously-bypass-approvals-and-sandbox",
  ]);
  expect(RUNTIMES.grok.autoApproveArgs).toEqual(["--always-approve"]);
  expect(RUNTIMES.opencode).toMatchObject({
    bin: "opencode",
    buildFlag: "--opencode",
    defaultModel: "opencode/big-pickle",
    defaultEffort: "",
    effortSuggestions: [],
    autoApproveArgs: ["--auto"],
  });
  expect(RUNTIMES.opencode.modelSuggestions.length).toBeGreaterThan(0);
  expect(CODING_AGENTS).toContain("opencode");
});

test("runtime definitions do not expose a session resume capability", () => {
  for (const runtime of Object.values(RUNTIMES)) {
    expect(runtime).not.toHaveProperty("resumable");
  }
});

test("Codex defaults to GPT-6 Astra and lists it first (#522)", () => {
  expect(RUNTIMES.codex.defaultModel).toBe("gpt-6-astra");
  expect(RUNTIMES.codex.modelSuggestions[0]).toBe("gpt-6-astra");
  // The older tiers stay selectable.
  expect(RUNTIMES.codex.modelSuggestions).toContain("gpt-5.6-sol");
  // The default effort is one Astra accepts.
  expect(
    effortSuggestionsForModel("codex", RUNTIMES.codex.defaultModel),
  ).toContain(RUNTIMES.codex.defaultEffort);
});

test("effortSuggestionsForModel offers Astra's levels without minimal (#522)", () => {
  expect(effortSuggestionsForModel("codex", "gpt-6-astra")).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  // An empty model means the runtime default, which is Astra.
  expect(effortSuggestionsForModel("codex", "")).toEqual(
    effortSuggestionsForModel("codex", "gpt-6-astra"),
  );
  // Models without an override keep the runtime ladder, minimal included.
  expect(effortSuggestionsForModel("codex", "gpt-5.6-sol")).toEqual(
    RUNTIMES.codex.effortSuggestions,
  );
  expect(effortSuggestionsForModel("codex", "gpt-5.6-sol")).toContain(
    "minimal",
  );
  // Runtimes with no per-model overrides answer with their own ladder.
  expect(effortSuggestionsForModel("claude-code", "opus")).toEqual(
    RUNTIMES["claude-code"].effortSuggestions,
  );
  expect(effortSuggestionsForModel("opencode", "")).toEqual([]);
});
