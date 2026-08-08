import type { WorkflowContractLanguage } from "./contracts.ts";

const ISSUE_CREATE_PROMPTS: Record<WorkflowContractLanguage, string> = {
  en: `Create an AFK-ready LoopHub issue from the user's request, then stop.

Your responsibility ends once the issue is filed. You write the issue; you never write the implementation. Even when the request reads like "fix this" or "build that", treat it as material for the issue rather than as work to carry out yourself.

First turn the request into a draft issue by inferring a concise title, the problem or goal, scope, issue type, verifiable acceptance criteria, and explicitly mentioned resources when reasonable. Before filing, check the draft for ambiguities or omissions that could materially change the implementation or how the result is verified. If one exists, ask the single highest-impact question first, offer a few concrete choices plus an option such as "Other" or "I'm not sure", and wait for the user's answer before asking another question. If the draft is sufficiently clear, file it without unnecessary questioning. If the user says to file it as-is, says they want to stop, or otherwise clearly cuts the questioning short, file the current draft and stop. If there is no request context yet, ask exactly one open question: "What's going on?" Write the title, headings, explanations, and questions in the user's selected natural language consistently.

Check for likely duplicate issues before filing. Once enough information is available, run \`lh issue create --help\` immediately before creating the issue and follow the installed CLI's current instructions. Then create the issue in the current repository with \`lh issue create\`, including the title, body, acceptance criteria, and related resources. Report the created issue number and stop. Do not implement the issue, create a branch, open a PR, or merge anything.`,
  ja: `ユーザーの依頼から AFK 対応の LoopHub issue を作成し、その後停止してください。

あなたの責務は issue を作成するところまでです。issue を書くのがあなたの仕事であり、実装そのものは決して行いません。依頼が「直してほしい」「作ってほしい」という形であっても、それは自分で着手する作業ではなく issue に書く材料として扱ってください。

まずユーザーの依頼から、簡潔な title、問題または goal、scope、issue type、検証可能な acceptance criteria、明示された関連リソースを、妥当な範囲で推論して issue の草案を作ってください。起票前に、実装の内容や結果の検証方法を大きく変えうる曖昧さや不足が草案にないか確認してください。ある場合は、最も影響の大きい質問を一問ずつ、具体的な選択肢をいくつかと「その他」や「わからない」などの選択肢を添えて尋ね、回答を待ってから次の質問をしてください。草案が十分に明確なら、不要な質問をせず起票してください。ユーザーが「そのまま起票したい」「質問を切り上げたい」など、深掘りを明確に止める指示を出した場合は、現在の草案で起票して停止してください。まだ依頼の内容がない場合は、open question を 1 つだけ「何が起きていますか？」と尋ねてください。title、見出し、説明、質問文は、選択された自然言語で一貫して記述してください。

重複しそうな issue がないか確認してください。十分な情報が集まったら、issue を作成する直前に \`lh issue create --help\` を実行し、インストールされている CLI の最新の説明に従ってください。その後、title、body、acceptance criteria、関連リソースを含めて、現在の repository に \`lh issue create\` で issue を作成してください。作成した issue 番号を報告して停止してください。issue の実装、branch の作成、PR の open、merge は行わないでください。`,
};

/** Return the New issue prompt, falling back to English for unknown settings. */
export function issueCreatePrompt(language: unknown): string {
  return language === "ja" ? ISSUE_CREATE_PROMPTS.ja : ISSUE_CREATE_PROMPTS.en;
}
