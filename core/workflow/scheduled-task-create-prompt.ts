import type { WorkflowContractLanguage } from "./contracts.ts";

const SCHEDULED_TASK_CREATE_PROMPTS: Record<WorkflowContractLanguage, string> =
  {
    en: `Create a LoopHub scheduled task from the user's request, then stop.

Collect only the missing pieces: a concise title, the prompt the task should run, the coding agent, one or more daily times in HH:MM format, and optional model and reasoning effort overrides. If there is no request context yet, ask exactly one open question: "What should the scheduled task do?" Ask small follow-up questions only for genuinely missing information. Write the title, prompt, and questions in the user's selected natural language consistently.

Once enough information is available, run \`lh scheduled-task create --help\` and follow the installed CLI's current instructions. Then create the task in the current repository with \`lh scheduled-task create\`. Report the created task id and stop. Do not run the task, edit project files, create an issue or PR, or implement anything.`,
    ja: `ユーザーの依頼から LoopHub scheduled task を作成し、その後停止してください。

必要な不足情報だけを集めてください。簡潔な title、task が実行する prompt、coding agent、HH:MM 形式の 1 つ以上の毎日の時刻、任意の model と reasoning effort override を確認します。まだ依頼の内容がない場合は、open question を 1 つだけ「scheduled task で何を実行しますか？」と尋ねてください。不足情報について小さな追加質問をするのは、本当に必要な場合だけにしてください。title、prompt、質問文は、選択された自然言語で一貫して記述してください。

十分な情報が集まったら、\`lh scheduled-task create --help\` を実行し、インストールされている CLI の最新の説明に従ってください。その後、現在の repository に \`lh scheduled-task create\` で task を作成してください。作成した task id を報告して停止してください。task の実行、project file の編集、issue や PR の作成、実装は行わないでください。`,
  };

/** Return the New scheduled task prompt, falling back to English for unknown settings. */
export function scheduledTaskCreatePrompt(language: unknown): string {
  return language === "ja"
    ? SCHEDULED_TASK_CREATE_PROMPTS.ja
    : SCHEDULED_TASK_CREATE_PROMPTS.en;
}
