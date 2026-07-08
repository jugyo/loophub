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

test("scheduled task command exposes run context and Inbox send instructions", () => {
  const cmd = buildScheduledTaskCommand({
    agent: "codex",
    prompt: "produce the report",
    context: {
      repo: "me/sched",
      taskId: 12,
      runId: 34,
    },
  });
  expect(cmd).toContain("LOOPHUB_SCHEDULED_TASK_KIND='scheduled_task'");
  expect(cmd).toContain("LOOPHUB_SCHEDULED_TASK_REPO='me/sched'");
  expect(cmd).toContain("LOOPHUB_SCHEDULED_TASK_ID='12'");
  expect(cmd).toContain("LOOPHUB_SCHEDULED_TASK_RUN_ID='34'");
  expect(cmd).toContain(
    `LOOPHUB_SCHEDULED_TASK_FROM='{"kind":"scheduled_task","repo":"me/sched","task_id":12,"run_id":34}'`,
  );
  expect(cmd).toContain("LoopHub scheduled task context:");
  expect(cmd).toContain("lh inbox send");
  expect(cmd).toContain(`--from "$LOOPHUB_SCHEDULED_TASK_FROM"`);
  expect(cmd).toContain("The label is display text only");
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
