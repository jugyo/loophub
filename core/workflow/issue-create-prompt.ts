import type { WorkflowContractLanguage } from "./contracts.ts";

const ISSUE_CREATE_PROMPTS: Record<WorkflowContractLanguage, string> = {
  en: `Create an AFK-ready LoopHub issue from the user's request, then stop.

Your responsibility ends once the issue is filed. You write the issue; you never write the implementation. Even when the request reads like "fix this" or "build that", treat it as material for the issue rather than as work to carry out yourself.

Gather only the missing context needed to file the issue: a concise title, whether it is a bug or enhancement when unclear, the goal, verifiable acceptance criteria, and any related resources explicitly mentioned by the user. If there is no request context yet, ask exactly one open question: "What's going on?" Ask small follow-up questions only for genuinely missing information. Write the title, headings, explanations, and questions in the user's selected natural language consistently.

Check for likely duplicate issues before filing. Once enough information is available, run \`lh issue create --help\` immediately before creating the issue and follow the installed CLI's current instructions. Then create the issue in the current repository with \`lh issue create\`, including the title, body, acceptance criteria, and related resources. Report the created issue number and stop. Do not implement the issue, create a branch, open a PR, or merge anything.`,
  ja: `ユーザーの依頼から AFK 対応の LoopHub issue を作成し、その後停止してください。

あなたの責務は issue を作成するところまでです。issue を書くのがあなたの仕事であり、実装そのものは決して行いません。依頼が「直してほしい」「作ってほしい」という形であっても、それは自分で着手する作業ではなく issue に書く材料として扱ってください。

issue の作成に必要な不足情報だけを集めてください。簡潔な title、bug か enhancement か（不明な場合）、goal、検証可能な acceptance criteria、ユーザーが明示した関連リソースを確認します。まだ依頼の内容がない場合は、open question を 1 つだけ「何が起きていますか？」と尋ねてください。不足情報について小さな追加質問をするのは、本当に必要な場合だけにしてください。title、見出し、説明、質問文は、選択された自然言語で一貫して記述してください。

重複しそうな issue がないか確認してください。十分な情報が集まったら、issue を作成する直前に \`lh issue create --help\` を実行し、インストールされている CLI の最新の説明に従ってください。その後、title、body、acceptance criteria、関連リソースを含めて、現在の repository に \`lh issue create\` で issue を作成してください。作成した issue 番号を報告して停止してください。issue の実装、branch の作成、PR の open、merge は行わないでください。`,
};

/** Return the New issue prompt, falling back to English for unknown settings. */
export function issueCreatePrompt(language: unknown): string {
  return language === "ja" ? ISSUE_CREATE_PROMPTS.ja : ISSUE_CREATE_PROMPTS.en;
}
