export const SCHEDULED_TASK_INBOX_KIND = "scheduled_task";
export const SCHEDULED_TASK_INBOX_LABEL = "scheduled_task";

export interface ScheduledTaskInboxContext {
  repo: string;
  taskId: number;
  runId: number;
}

export interface ScheduledTaskInboxSource {
  kind: typeof SCHEDULED_TASK_INBOX_KIND;
  repo: string;
  task_id: number;
  run_id: number;
}

export function scheduledTaskInboxSource(
  context: ScheduledTaskInboxContext,
): ScheduledTaskInboxSource {
  return {
    kind: SCHEDULED_TASK_INBOX_KIND,
    repo: context.repo,
    task_id: context.taskId,
    run_id: context.runId,
  };
}

export function scheduledTaskInboxEnv(
  context: ScheduledTaskInboxContext,
): Record<string, string> {
  return {
    LOOPHUB_SCHEDULED_TASK_KIND: SCHEDULED_TASK_INBOX_KIND,
    LOOPHUB_SCHEDULED_TASK_REPO: context.repo,
    LOOPHUB_SCHEDULED_TASK_ID: String(context.taskId),
    LOOPHUB_SCHEDULED_TASK_RUN_ID: String(context.runId),
    LOOPHUB_SCHEDULED_TASK_FROM: JSON.stringify(
      scheduledTaskInboxSource(context),
    ),
  };
}

export function scheduledTaskInboxPromptSuffix(
  context: ScheduledTaskInboxContext,
): string {
  const from = JSON.stringify(scheduledTaskInboxSource(context));
  return [
    "",
    "LoopHub scheduled task context:",
    `- repo: ${context.repo}`,
    `- kind: ${SCHEDULED_TASK_INBOX_KIND}`,
    `- task_id: ${context.taskId}`,
    `- run_id: ${context.runId}`,
    "",
    "When the work is finished, send a human-facing Inbox message with the result.",
    "Use the environment variables provided by the launcher, for example:",
    `printf '%s\\n' '<result details>' | lh inbox send --repo "$LOOPHUB_SCHEDULED_TASK_REPO" --from "$LOOPHUB_SCHEDULED_TASK_FROM" --label '${SCHEDULED_TASK_INBOX_LABEL}' --title '<short result title>' --body -`,
    "",
    "The explicit from JSON for this run is:",
    from,
    "",
    "The label is display text only; do not treat it as routing or control behavior.",
  ].join("\n");
}
