import { expect, test } from "vitest";
import { RUNTIMES } from "./runtimes.ts";

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

test("grok modelSuggestions includes grok-4.5 and keeps existing models", () => {
  expect(RUNTIMES.grok.modelSuggestions).toEqual([
    "grok-code-fast-1",
    "grok-4.5",
    "grok-4",
    "grok-4-fast",
    "grok-3",
  ]);
});
