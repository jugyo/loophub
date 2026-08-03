import type { WorkflowContractLanguage } from "./contracts.ts";

const WORKFLOW_CREATE_PROMPTS: Record<WorkflowContractLanguage, string> = {
  en: `Create a LoopHub workflow from the user's request, then stop.

A workflow is a global or repository-scoped prompt bundle for the fixed Execute/Verify development loop. The Execute and Verify step contracts are fixed by LoopHub; the only configurable part is the additive per-step guidance a user writes on top of each contract. You gather that guidance and create the workflow; you never run a workflow or implement anything.

Collect only the missing pieces: a concise name, an optional one-line description, the additive Execute-step guidance (execute prompt), and the additive Verify-step guidance (verify prompt). If there is no request context yet, ask exactly one open question: "What kind of workflow do you want to create?" Ask small follow-up questions only for genuinely missing information. Write the name, description, and prompts in the user's selected natural language consistently.

Once enough information is available, create the workflow with \`lh workflow create <name> --description <description> --execute-prompt <text> --verify-prompt <text>\`. Report the created workflow name and stop. Do not start a workflow run, create an issue or PR, or edit any workflow.`,
  ja: `ユーザーの依頼から LoopHub workflow を作成し、その後停止してください。

workflow は固定の Execute/Verify 開発ループ用の global または repository 固有の prompt バンドルです。Execute / Verify のステップ contract は LoopHub が固定しており、設定できるのは各 contract の上にユーザーが書く追加的なステップごとの指示だけです。あなたはその指示を集めて workflow を作成するのが仕事であり、workflow の実行や実装そのものは決して行いません。

不足している要素だけを集めてください。簡潔な name、任意の 1 行 description、追加的な Execute ステップの指示 (execute prompt)、追加的な Verify ステップの指示 (verify prompt) を確認します。まだ依頼の内容がない場合は、open question を 1 つだけ「どのような workflow を作成したいですか？」と尋ねてください。不足情報について小さな追加質問をするのは、本当に必要な場合だけにしてください。name、description、prompt は、選択された自然言語で一貫して記述してください。

十分な情報が集まったら、\`lh workflow create <name> --description <description> --execute-prompt <text> --verify-prompt <text>\` で workflow を作成してください。作成した workflow 名を報告して停止してください。workflow run の開始、issue や PR の作成、既存 workflow の編集は行わないでください。`,
};

/** Return the New workflow prompt, falling back to English for unknown settings. */
export function workflowCreatePrompt(language: unknown, repo?: string): string {
  const base =
    language === "ja" ? WORKFLOW_CREATE_PROMPTS.ja : WORKFLOW_CREATE_PROMPTS.en;
  if (!repo) return base;
  return language === "ja"
    ? `${base}\n\nこの workflow は repository \`${repo}\` 専用です。作成コマンドに必ず \`--repo ${repo}\` を追加してください。`
    : `${base}\n\nThis workflow is scoped to repository \`${repo}\`. Always add \`--repo ${repo}\` to the create command.`;
}
