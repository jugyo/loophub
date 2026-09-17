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

test("OpenCode 2 is registered as its own runtime with its own model list (#545)", () => {
  expect(CODING_AGENTS).toContain("opencode2");
  expect(RUNTIMES.opencode2).toMatchObject({
    id: "opencode2",
    bin: "opencode2",
    label: "OpenCode 2",
    buildFlag: "--opencode2",
    defaultModel: "opencode/big-pickle",
    defaultEffort: "",
    // No effort ladder, so the Settings screen shows no effort picker for it.
    effortSuggestions: [],
    sandboxCapable: false,
    autoApproveArgs: ["--auto"],
    // Shared with Codex and OpenCode 1, so one skill write serves all three (#556).
    skillsDir: ".agents/skills",
  });
  // Taken from `opencode2 models`, which is not the same list OpenCode 1 reports.
  expect(RUNTIMES.opencode2.modelSuggestions).toContain("opencode-go/grok-4.6");
  expect(RUNTIMES.opencode2.modelSuggestions).not.toContain(
    "opencode/deepseek-v4-flash-free",
  );
  expect(effortSuggestionsForModel("opencode2", "")).toEqual([]);
  // Its TUI only pre-fills `--prompt`, so the launch has to submit it (#545).
  expect(RUNTIMES.opencode2.launchPromptNeedsSubmit).toBe(true);
  // OpenCode 1 keeps its own binary and flag.
  expect(RUNTIMES.opencode.bin).toBe("opencode");
  expect(RUNTIMES.opencode.buildFlag).toBe("--opencode");
});

test("only OpenCode 2 needs its launch prompt submitted (#545)", () => {
  for (const runtime of ["claude-code", "codex", "grok", "opencode"] as const) {
    expect(RUNTIMES[runtime].launchPromptNeedsSubmit).toBe(false);
  }
});

test("Antigravity auto-approves tools and uses the shared skills directory", () => {
  expect(CODING_AGENTS).toContain("agy");
  expect(RUNTIMES.agy).toMatchObject({
    bin: "agy",
    label: "Antigravity",
    buildFlag: "--agy",
    skillsDir: ".agents/skills",
    autoApproveArgs: ["--dangerously-skip-permissions"],
    launchPromptNeedsSubmit: false,
  });
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

// Every field callers dereference has to exist on every entry. TypeScript already requires them,
// but a registry that only typechecks in CI lets a missing one reach a caller as `undefined` —
// `lh skill install --all` joined `undefined` into a path when opencode2 shipped without
// `skillsDir` (#556). Check the whole registry here so the next runtime cannot repeat it.
test("every runtime defines every registry field (#556)", () => {
  for (const id of CODING_AGENTS) {
    const runtime = RUNTIMES[id];
    for (const field of [
      "id",
      "bin",
      "label",
      "buildFlag",
      "defaultModel",
      "defaultEffort",
      "modelSuggestions",
      "effortSuggestions",
      "sandboxCapable",
      "skillsDir",
      "autoApproveArgs",
      "launchPromptNeedsSubmit",
    ] as const) {
      expect(runtime[field], `${id}.${field}`).toBeDefined();
    }
    // The fields with no meaningful empty value: a blank one would silently install, launch or
    // display nothing.
    expect(runtime.id, "id").toBe(id);
    expect(runtime.bin.length, `${id}.bin`).toBeGreaterThan(0);
    expect(runtime.label.length, `${id}.label`).toBeGreaterThan(0);
    expect(runtime.buildFlag, `${id}.buildFlag`).toMatch(/^--/);
    expect(runtime.defaultModel.length, `${id}.defaultModel`).toBeGreaterThan(
      0,
    );
    expect(
      runtime.modelSuggestions.length,
      `${id}.modelSuggestions`,
    ).toBeGreaterThan(0);
    expect(runtime.skillsDir, `${id}.skillsDir`).toMatch(/^\.[^/]+\/skills$/);
    expect(
      runtime.autoApproveArgs.length,
      `${id}.autoApproveArgs`,
    ).toBeGreaterThan(0);
  }
});
