import type { WorkflowContractLanguage } from "./contracts.ts";

const ISSUE_CREATE_PROMPTS: Record<WorkflowContractLanguage, string> = {
  en: `Create an AFK-ready LoopHub issue from the user's request, then stop.

Gather only the missing context needed to file the issue: a concise title, whether it is a bug or enhancement when unclear, the goal, verifiable acceptance criteria, and any related resources explicitly mentioned by the user. If there is no request context yet, ask exactly one open question: "What's going on?" Ask small follow-up questions only for genuinely missing information. Write the title, headings, explanations, and questions in the user's selected natural language consistently.

Check for likely duplicate issues before filing. Once enough information is available, create the issue in the current repository with \`lh issue create\`, including the title, body, acceptance criteria, and related resources. Report the created issue number and stop. Do not implement the issue, create a branch, open a PR, or merge anything.`,
  ja: `ユーザーの依頼から AFK 対応の LoopHub issue を作成し、その後停止してください。

issue の作成に必要な不足情報だけを集めてください。簡潔な title、bug か enhancement か（不明な場合）、goal、検証可能な acceptance criteria、ユーザーが明示した関連リソースを確認します。まだ依頼の内容がない場合は、open question を 1 つだけ「何が起きていますか？」と尋ねてください。不足情報について小さな追加質問をするのは、本当に必要な場合だけにしてください。title、見出し、説明、質問文は、選択された自然言語で一貫して記述してください。

重複しそうな issue がないか確認してください。十分な情報が集まったら、title、body、acceptance criteria、関連リソースを含めて、現在の repository に \`lh issue create\` で issue を作成してください。作成した issue 番号を報告して停止してください。issue の実装、branch の作成、PR の open、merge は行わないでください。`,
};

/** Return the New issue prompt, falling back to English for unknown settings. */
export function issueCreatePrompt(language: unknown): string {
  return language === "ja" ? ISSUE_CREATE_PROMPTS.ja : ISSUE_CREATE_PROMPTS.en;
}
