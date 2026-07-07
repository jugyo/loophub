import { expect, test } from "vitest";
import { buildScheduledTaskCommand } from "./terminal-launch.ts";

test("claude command runs the prompt in print mode with permission-mode auto", () => {
  const cmd = buildScheduledTaskCommand({
    agent: "claude-code",
    prompt: "do the thing",
    model: "opus",
  });
  expect(cmd).toBe(
    "claude -p 'do the thing' --permission-mode auto --model 'opus'",
  );
});

test("codex command runs sandboxed (workspace-write), not a full bypass, with model + effort", () => {
  const cmd = buildScheduledTaskCommand({
    agent: "codex",
    prompt: "lint",
    model: "gpt-5.5",
    effort: "high",
  });
  expect(cmd).toContain("codex exec");
  expect(cmd).toContain("--sandbox");
  expect(cmd).toContain("workspace-write");
  // #880 security review: scheduled codex fires must NOT disable the sandbox.
  expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(cmd).toContain("--model 'gpt-5.5'");
  expect(cmd).toContain("model_reasoning_effort=high");
});

test("a crafted prompt cannot break out of the single-quoted argument", () => {
  const cmd = buildScheduledTaskCommand({
    agent: "claude-code",
    prompt: "'; rm -rf / #",
  });
  // The quote is escaped as the canonical '\'' sequence, so the injected `;`/`rm` stay inside the
  // single-quoted prompt argument rather than becoming shell syntax.
  expect(cmd).toContain(`'\\''`);
  expect(cmd.startsWith("claude -p '")).toBe(true);
});
