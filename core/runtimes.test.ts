import { expect, test } from "vitest";
import { CODING_AGENTS, RUNTIMES } from "./runtimes.ts";

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
