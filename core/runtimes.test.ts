import { expect, test } from "vitest";
import { CODING_AGENTS, RUNTIMES } from "./runtimes.ts";

test("Claude Code suggests the fable model", () => {
  expect(RUNTIMES["claude-code"].modelSuggestions).toContain("claude-fable-5");
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
  expect(RUNTIMES.cursor).toMatchObject({
    bin: "cursor-agent",
    buildFlag: "--cursor",
    defaultModel: "auto",
    effortSuggestions: [],
    autoApproveArgs: ["--force", "--sandbox", "disabled", "--approve-mcps"],
  });
  expect(CODING_AGENTS).toContain("cursor");
  expect(RUNTIMES.opencode).toMatchObject({
    bin: "opencode",
    buildFlag: "--opencode",
    defaultModel: "opencode/big-pickle",
    autoApproveArgs: ["--auto"],
  });
  expect(RUNTIMES.opencode.modelSuggestions.length).toBeGreaterThan(0);
  expect(RUNTIMES.opencode.effortSuggestions).toEqual([
    "minimal",
    "low",
    "medium",
    "high",
    "max",
  ]);
  expect(CODING_AGENTS).toContain("opencode");
});

test("runtime definitions do not expose a session resume capability", () => {
  for (const runtime of Object.values(RUNTIMES)) {
    expect(runtime).not.toHaveProperty("resumable");
  }
});
