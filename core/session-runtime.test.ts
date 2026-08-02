import { expect, test } from "vitest";
import {
  isClaudeSessionId,
  RUNTIME_CLAUDE_CODE,
  sessionRuntime,
} from "./session-runtime.ts";

test("isClaudeSessionId accepts a UUID", () => {
  expect(isClaudeSessionId("d8a43602-f469-4b03-8fa8-0af5200f22b3")).toBe(true);
  expect(isClaudeSessionId("11111111-1111-4111-8111-111111111111")).toBe(true);
});

test("isClaudeSessionId rejects flag-like, malformed, and empty ids", () => {
  expect(isClaudeSessionId("--dangerously-skip-permissions")).toBe(false);
  expect(isClaudeSessionId("-r")).toBe(false);
  expect(isClaudeSessionId("not-a-uuid")).toBe(false);
  expect(isClaudeSessionId("")).toBe(false);
  expect(isClaudeSessionId(null)).toBe(false);
  expect(isClaudeSessionId(undefined)).toBe(false);
});

test("sessionRuntime prefers the explicit runtime column", () => {
  expect(sessionRuntime({ runtime: "claude-code", agent: "lh-build" })).toBe(
    RUNTIME_CLAUDE_CODE,
  );
  expect(sessionRuntime({ runtime: "codex", agent: "lh-build" })).toBe("codex");
});

test("sessionRuntime preserves historical build runtime identity", () => {
  expect(sessionRuntime({ runtime: null, agent: "lh-build" })).toBe(
    RUNTIME_CLAUDE_CODE,
  );
  expect(sessionRuntime({ agent: "lh-build" })).toBe(RUNTIME_CLAUDE_CODE);
  expect(sessionRuntime({ runtime: null, agent: "lh-dev" })).toBe(
    RUNTIME_CLAUDE_CODE,
  );
});

test("sessionRuntime is null without runtime provenance", () => {
  expect(sessionRuntime({ runtime: null, agent: "impl-bot" })).toBeNull();
  expect(sessionRuntime(null)).toBeNull();
  expect(sessionRuntime(undefined)).toBeNull();
});
