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

test("codex command runs in auto mode with model + effort", () => {
  const cmd = buildScheduledTaskCommand({
    agent: "codex",
    prompt: "lint",
    model: "gpt-5.5",
    effort: "high",
  });
  expect(cmd).toContain("codex exec");
  expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(cmd).toContain("--model 'gpt-5.5'");
  expect(cmd).toContain("model_reasoning_effort=high");
});

test("scheduled task command exposes run context and Notification center instructions", () => {
  const cmd = buildScheduledTaskCommand({
    agent: "codex",
    prompt: "produce the report",
    context: {
      repo: "me/sched",
      taskId: 12,
      runId: 34,
    },
  });
  expect(cmd).toContain("LOOPHUB_SCHEDULED_TASK_REPO='me/sched'");
  expect(cmd).toContain("LOOPHUB_SCHEDULED_TASK_ID='12'");
  expect(cmd).toContain("LOOPHUB_SCHEDULED_TASK_RUN_ID='34'");
  expect(cmd).toContain("LoopHub scheduled task context:");
  expect(cmd).toContain("lh notification send");
  expect(cmd).toContain("--kind human_attention");
  expect(cmd).toContain(
    `--source-key "scheduled-task:$LOOPHUB_SCHEDULED_TASK_ID:run:$LOOPHUB_SCHEDULED_TASK_RUN_ID:completed"`,
  );
  expect(cmd).not.toContain("inbox");
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
