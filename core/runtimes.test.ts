import { expect, test } from "vitest";
import { RUNTIMES } from "./runtimes.ts";

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
});
