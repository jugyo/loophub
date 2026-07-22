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

test("codex defaults to gpt-5.6-sol and suggests the current models in order", () => {
  expect(RUNTIMES.codex.defaultModel).toBe("gpt-5.6-sol");
  expect(RUNTIMES.codex.modelSuggestions).toEqual([
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
  ]);
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
