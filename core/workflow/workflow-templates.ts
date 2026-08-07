// Starter workflow templates (#2396). A workflow's only configurable part is the additive
// per-step guidance written on top of the fixed Execute/Verify contracts, so a template is just a
// name, a description, and those two prompts. Creating from a template copies these values into a
// normal workflow; nothing links the created workflow back to its template.
//
// Keep the bodies generic: they ship with LoopHub and must not assume one repository, one house
// style, or one runtime's tooling. They also must not restate what the Execute/Verify contracts
// already require (reading the issue, committing, updating the PR, submitting the review).
//
// The prose follows the workflow contract language so a created workflow reads in the same
// language as the contracts it is layered on. The names stay English in both: they are structural
// labels for the loop a template sets up, not prose.

import type { WorkflowContractLanguage } from "./contracts.ts";

export type WorkflowTemplate = {
  name: string;
  description: string;
  execute_prompt: string;
  verify_prompt: string;
};

const ENGLISH_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    name: "Build",
    description: "Implement the issue, then verify it independently.",
    execute_prompt: `Implement a focused change that matches the surrounding naming, types, tests, and style. Do not refactor unrelated code, and do not add behavior the issue did not ask for.

Cover the change with tests at the layer the repository already tests, and run its standard test, lint, and typecheck commands before you commit.

For a change with a visible surface, exercise it yourself instead of reasoning about it: run the affected screen or command, capture the result, and attach the evidence to the PR. When no capture path is available, say so explicitly and record the alternative verification you ran.

Write the deliverable for the people who will read it later. Keep run, session, and workspace identifiers out of the code, documentation, commit messages, and PR body.`,
    verify_prompt: `Judge the fixed diff on two axes. First, acceptance behavior: take each enabled criterion and check the normal path, the boundaries, the failure path, and the user-visible result. Second, correctness and regression: check the change against the repository's existing contracts, types, invariants, and state transitions, and look for broken error paths, backward incompatibility, data loss, and behavior that used to work.

If the runtime offers child agents, you may split those two axes across them; give each child the issue, the base and head SHAs, its axis, and the criteria it owns, and validate what it returns before you rely on it. Do not retry a child that failed — record that it did not finish and cover its axis yourself. Without child agents, do both yourself.

For a change with a visible surface, reproduce it yourself and judge what you see. Do not accept the implementer's screenshots or description as evidence.`,
  },
  {
    name: "Design",
    description: "Produce a design document from the issue. No implementation.",
    execute_prompt: `Deliver a design document in Markdown. Do not change code, schemas, or configuration in this workflow.

Before deciding anything, read the existing code, architecture, and neighboring design documents so the design rests on the real structure and its constraints rather than on assumptions.

Include at least the following, in the depth the issue calls for:

- The background and the problem to solve
- Goals and non-goals
- The options you considered and their trade-offs
- The design you chose and why
- The impact surface: the modules, data, and interfaces expected to change
- The main design decisions and how they fit the repository's existing conventions
- Risks, open questions, and follow-up work

Match the language, terminology, structure, and level of detail of the repository's existing design documents, and place the file where they live. The document must stand on its own: a reader with no access to this session should understand it and be able to use it as the input to an implementation issue.

If the purpose, audience, required contents, location, or a premise of the design is missing and you cannot decide the deliverable, do not fill the gap with a guess. Escalate with the concrete question as the Execute contract describes.`,
    verify_prompt: `Treat the issue as the only statement of the requirement, and judge the design document contained in the fixed diff. Do not treat the implementer's explanation or intent as evidence.

Check at least that the document:

- Answers every design question and acceptance criterion the issue raises
- States goals and non-goals clearly, and stays consistent with them
- Considers the plausible options and justifies the chosen one against its trade-offs
- Describes an impact surface concrete enough to drive an implementation issue
- Keeps its main decisions consistent with the repository's existing conventions
- Stands on its own, without relying on knowledge that exists only in the repository's history or in a session
- Matches the conventions, placement, and detail of neighboring documents
- Does not smuggle in implementation or changes the issue did not ask for

Read the code the document cites and confirm that the paths, behavior, and constraints it describes are real.`,
  },
  {
    name: "Investigate",
    description:
      "Investigate existing behavior and document it with citations. No implementation.",
    execute_prompt: `Answer from the actual implementation and schema, never from memory or inference. Read the code.

Deliver a new, short document that states the conclusions directly. Give every claim a specific \`file:line\` citation. Do not pad it with narrative, restated background, or speculation, and do not append to an unrelated existing document.

Do not implement anything. The evidence for this work is the set of search commands that locate each cited definition — record them, and treat the investigation as verified once each citation is confirmed to exist.

If the question itself is ambiguous enough that different readings would produce different findings, escalate with the concrete question as the Execute contract describes rather than picking one silently.`,
    verify_prompt: `Do not trust the claims in the document. Open each cited \`file:line\` yourself and confirm that the code actually supports the claim made about it.

Check that every acceptance criterion is genuinely answered, not merely mentioned, and flag every claim in the diff that no citation backs.

Also flag citations that point at real code but do not show what the document says they show — a stale line number, a different code path, or a conclusion broader than the evidence.`,
  },
  {
    name: "Research",
    description:
      "Gather and analyze real data, then deliver a sourced report. No implementation.",
    execute_prompt: `Deliver a Markdown report backed by evidence. Do not change code or schemas in this workflow.

Identify where the data and information that answer the question actually live, and read them before you analyze. Never invent a number or a fact. Every figure and claim in the report names the source that produced it — a query, an API, a file, a document — so that a reader can reproduce and check it by following the same steps.

The analysis should at least:

- Derive the driver metrics that decide the conclusion from real data, such as a rate, a per-unit amount, or a per-unit cost
- Present any estimate or forecast as a transparent model — the derived drivers multiplied by stated assumptions — so the arithmetic can be followed
- Give a range or several scenarios where an assumption is uncertain, instead of a single confident number
- State the assumptions, sources, method, and what was deliberately excluded

Some premises cannot be settled from data: a future growth expectation, a business decision, something only the people involved know. Do not fabricate or guess these. List them explicitly as questions for a human and mark them as outside your scope. If the work cannot continue without an answer, escalate with the concrete question as the Execute contract describes.

Match the language, terminology, structure, and detail of the repository's existing documents, and place the report where they live. It must stand on its own as the input to a decision or a follow-up issue.`,
    verify_prompt: `Treat the issue as the only statement of the question, and judge the report contained in the fixed diff. Do not treat the implementer's explanation as evidence.

Do not trust the numbers. Open the cited sources yourself and confirm that each figure, fact, and conclusion is what the source actually says. Flag every number or claim whose source is missing or does not support it.

Check at least that the report:

- Answers the question and every acceptance criterion the issue raises
- Derives its driver metrics from real data and names their sources
- Presents a calculation model transparent enough to reproduce the conclusion from the stated assumptions and figures
- Offers a defensible range or set of scenarios wherever an assumption is uncertain
- Leaves the premises that data cannot settle as explicit questions for a human, rather than filling them in
- States its assumptions, sources, method, and exclusions at a reproducible level of detail
- Stands on its own, without relying on knowledge that exists only in a session
- Does not include implementation or changes the issue did not ask for`,
  },
];

const JAPANESE_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    name: "Build",
    description: "issue を実装し、独立に検証する。",
    execute_prompt: `周辺コードの命名、型、テスト、スタイルに合わせ、変更の焦点を絞って実装してください。無関係なコードのリファクタリングや、issue が求めていない挙動の追加は行わないでください。

repository が既にテストしている層で変更をテストで覆い、commit の前に標準の test / lint / typecheck コマンドを実行してください。

利用者から見える変更では、推論で済ませず自分で動かしてください。該当する画面やコマンドを実行し、結果を取得して PR に添付します。取得手段が無い場合は、その事実を明記したうえで、代わりに行った検証を記録してください。

成果物は後から読む人のために書いてください。run、session、workspace の識別子を、コード、ドキュメント、commit message、PR body に書き込まないでください。`,
    verify_prompt: `固定された diff を 2 つの観点で評価してください。1 つ目は acceptance behavior で、enabled な criterion を 1 件ずつ取り上げ、正常系、境界値、失敗時、利用者から見える結果を確認します。2 つ目は correctness / regression で、repository の既存 contract、型、不変条件、状態遷移との整合を確認し、error path の破壊、後方互換性、データ損失、これまで動いていた挙動の回帰を探します。

runtime が child agent を提供する場合は、この 2 観点を分担させても構いません。各 child には issue、base SHA、head SHA、担当観点、担当する criteria を明示し、返ってきた内容は自分で検証してから採用してください。失敗した child を自動 retry しないでください。完了しなかった事実を記録し、その観点は自分で確認します。child agent が無い場合は両方を自分で行ってください。

利用者から見える変更では、自分で再現して目で確認し、判断してください。実装者のスクリーンショットや説明を根拠にしないでください。`,
  },
  {
    name: "Design",
    description: "issue から設計ドキュメントを作成する。実装はしない。",
    execute_prompt: `成果物は Markdown の設計ドキュメントです。この workflow ではコード、スキーマ、設定を変更しないでください。

何かを決める前に、既存のコード、アーキテクチャ、周辺の設計ドキュメントを読んでください。想定ではなく実際の構造とその制約の上に設計を組み立てます。

issue が求める深さに応じて、少なくとも次を含めてください。

- 背景と解決すべき問題
- 目標（Goals）と非目標（Non-goals）
- 検討した選択肢と、それぞれのトレードオフ
- 採用する設計案と、その判断根拠
- 影響範囲: 変更が想定されるモジュール、データ、インターフェース
- 主要な設計判断と、既存の規約との整合
- リスク、未解決の論点、今後の作業

repository の既存の設計ドキュメントの言語、用語、構成、詳細度に合わせ、それらが置かれている場所に配置してください。ドキュメントは単体で成立している必要があります。この session を参照できない読者が理解でき、実装 issue の入力として使える内容にしてください。

目的、想定読者、必須内容、配置先、設計の前提のいずれかが不足していて成果物を決められない場合は、推測で埋めないでください。具体的な質問を添えて、Execute step contract に従い escalate してください。`,
    verify_prompt: `issue を要求の唯一の基準として扱い、固定された diff に含まれる設計ドキュメントそのものを評価してください。実装者の説明や意図を根拠にしないでください。

少なくとも次を確認してください。

- issue が挙げる設計上の問いと acceptance criteria にすべて答えているか
- 目標と非目標が明確で、設計がそれらと整合しているか
- 妥当な選択肢を検討し、採用案をトレードオフに照らして根拠づけているか
- 影響範囲が具体的で、実装 issue を駆動できる粒度か
- 主要な判断が repository の既存の規約と整合しているか
- repository の履歴や session にしか存在しない知識に依存せず、単体で成立しているか
- 周辺ドキュメントの規約、配置、詳細度に合っているか
- 実装や、issue が求めていない変更を紛れ込ませていないか

ドキュメントが引用しているコードを自分で読み、記述されているパス、挙動、制約が実際に存在することを確認してください。`,
  },
  {
    name: "Investigate",
    description: "既存の挙動を調査し、引用付きで文書化する。実装はしない。",
    execute_prompt: `記憶や推論ではなく、実際の実装とスキーマから答えてください。コードを読んでください。

成果物は、結論を直接述べる新規の短いドキュメントです。すべての主張に具体的な \`file:line\` の引用を付けてください。物語調の記述、繰り返しの背景説明、推測で水増ししないでください。無関係な既存ドキュメントへの追記もしないでください。

実装は行いません。この作業のエビデンスは、引用した各定義を特定できる検索コマンドです。それらを記録し、各引用の存在が確認できた時点で検証済みとして扱ってください。

問い自体が曖昧で、解釈によって結論が変わる場合は、黙って 1 つを選ばずに、具体的な質問を添えて Execute step contract に従い escalate してください。`,
    verify_prompt: `ドキュメントの主張を信用しないでください。引用された \`file:line\` を自分で開き、そのコードが実際に主張を裏付けているか確認してください。

各 acceptance criterion が、言及されているだけでなく実際に答えられているかを確認し、diff 内で引用に裏付けられていない主張はすべて指摘してください。

実在するコードを指してはいるが、ドキュメントの言う内容を示していない引用も指摘してください。行番号のずれ、別の code path、根拠より広い結論が該当します。`,
  },
  {
    name: "Research",
    description:
      "実データを収集・分析し、根拠付きのレポートを作成する。実装はしない。",
    execute_prompt: `成果物は根拠に裏付けられた Markdown のレポートです。この workflow ではコードやスキーマを変更しないでください。

問いに答えるためのデータや情報が実際にどこにあるかを特定し、分析の前に実物を読んでください。数値や事実を捏造しないでください。レポート中のすべての数値と主張には、それを生んだソース（クエリ、API、ファイル、ドキュメント）を明記し、読者が同じ手順で再現・確認できるようにしてください。

分析では少なくとも次を満たしてください。

- 結論を左右するドライバ指標を実データから算出する（率、単位あたりの量、単位あたりのコストなど）
- 試算や予測は、算出したドライバに明示した前提を掛け合わせる透明なモデルとして提示し、計算過程を追えるようにする
- 前提が不確実な箇所では、単一の断定的な数値ではなくレンジまたは複数シナリオを示す
- 前提、データソース、計算方法、意図的に除外した要素を明記する

データからは確定できない前提があります。今後の増加見込み、経営判断、当事者しか知らない事情などです。これらを捏造・推測で埋めないでください。人間への質問として明示的に列挙し、自分の担当範囲外であることを示してください。回答が無いと作業を継続できない場合は、具体的な質問を添えて Execute step contract に従い escalate してください。

repository の既存ドキュメントの言語、用語、構成、詳細度に合わせ、それらが置かれている場所に配置してください。レポートは、意思決定や後続 issue の入力として単体で成立している必要があります。`,
    verify_prompt: `issue を問いの唯一の基準として扱い、固定された diff に含まれるレポートそのものを評価してください。実装者の説明を根拠にしないでください。

数値を信用しないでください。引用されたソースを自分で開き、各数値・事実・結論がソースの実際の内容と一致するか確認してください。ソースが示されていない、またはソースが裏付けていない数値・主張はすべて指摘してください。

少なくとも次を確認してください。

- issue の問いと acceptance criteria にすべて答えているか
- ドライバ指標が実データから算出され、その出所が明記されているか
- 計算モデルが透明で、示された前提と数値から結論を再現できるか
- 不確実な前提に対して妥当なレンジまたはシナリオが示されているか
- データで確定できない前提が埋められておらず、人間への質問として明示されているか
- 前提、データソース、計算方法、除外要素が再現可能な粒度で明記されているか
- session にしか存在しない知識に依存せず、単体で成立しているか
- 実装や、issue が求めていない変更を含んでいないか`,
  },
];

/** Return the starter templates, falling back to English for unknown settings. */
export function workflowTemplates(
  language: unknown,
): readonly WorkflowTemplate[] {
  return language === "ja" ? JAPANESE_TEMPLATES : ENGLISH_TEMPLATES;
}

export const WORKFLOW_TEMPLATES_BY_LANGUAGE: Record<
  WorkflowContractLanguage,
  readonly WorkflowTemplate[]
> = {
  en: ENGLISH_TEMPLATES,
  ja: JAPANESE_TEMPLATES,
};
