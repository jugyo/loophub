export interface ScheduledTaskNotificationContext {
  repo: string;
  taskId: number;
  runId: number;
}

export function scheduledTaskNotificationEnv(
  context: ScheduledTaskNotificationContext,
): Record<string, string> {
  return {
    LOOPHUB_SCHEDULED_TASK_REPO: context.repo,
    LOOPHUB_SCHEDULED_TASK_ID: String(context.taskId),
    LOOPHUB_SCHEDULED_TASK_RUN_ID: String(context.runId),
  };
}

export function scheduledTaskNotificationPromptSuffix(
  context: ScheduledTaskNotificationContext,
): string {
  return [
    "",
    "LoopHub scheduled task context:",
    `- repo: ${context.repo}`,
    `- task_id: ${context.taskId}`,
    `- run_id: ${context.runId}`,
    "",
    "When the work is finished, send a human-facing Notification center notification with the result.",
    "Use the environment variables provided by the launcher, for example:",
    `printf '%s\\n' "Scheduled task ID: $LOOPHUB_SCHEDULED_TASK_ID\\nRun ID: $LOOPHUB_SCHEDULED_TASK_RUN_ID\\n\\n<result details>" | lh notification send --repo "$LOOPHUB_SCHEDULED_TASK_REPO" --kind human_attention --resource repo --source-key "scheduled-task:$LOOPHUB_SCHEDULED_TASK_ID:run:$LOOPHUB_SCHEDULED_TASK_RUN_ID:completed" --title '<short result title>' --body -`,
  ].join("\n");
}
