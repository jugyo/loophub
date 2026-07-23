import type { WorkflowStep } from "./compose.ts";
import type { WorkflowContractLanguage } from "./contracts.ts";

export type WorkflowMessages = {
  contractContext(input: {
    step: WorkflowStep | "parent";
    worktreePath: string;
    baseBranch: string;
  }): string[];
  languageInstruction: string;
  inputsHeading: string;
  stepWorktree(input: { worktreePath: string; baseBranch: string }): string;
  stepPromptHeading: string;
  workflowAgentNoteHeading: string;
  noneStepPrompt: string;
  parentPrompt(input: {
    runId: number;
    repoName: string;
    repoArg: string;
    workflowName: string;
    issueNumber: number;
    prNumber: number;
    baseRef: string;
  }): string[];
  reviewSubmissionInstruction: string;
  handoffLaunchIntro(step: WorkflowStep, runId: number): string;
  handoffParentNoteHeading: string;
  handoffSummary(step: WorkflowStep): string;
};

type WorkflowMessageCatalog = {
  [Key in keyof WorkflowMessages]: Record<
    WorkflowContractLanguage,
    WorkflowMessages[Key]
  >;
};

// Keep each English phrase beside its translation so changes to one language make a stale
// counterpart visible in the same diff hunk.
const WORKFLOW_MESSAGE_CATALOG = {
  contractContext: {
    en: (input) => [
      "## Workflow contract context",
      `step: ${input.step}`,
      `worktree: ${input.worktreePath}`,
      `base branch: ${input.baseBranch}`,
    ],
    ja: (input) => [
      "## Workflow contract コンテキスト",
      `step: ${input.step}`,
      `worktree: ${input.worktreePath}`,
      `base branch: ${input.baseBranch}`,
    ],
  },
  languageInstruction: {
    en: [
      "## Language",
      "",
      "Write this run's natural-language outputs (plans, reports, reviews, summaries, notes, and comments) in English. Keep code, identifiers, commands, paths, and quoted log or error text in their original form.",
    ].join("\n"),
    ja: [
      "## 言語",
      "",
      "この run の自然言語出力(plan、report、review、summary、note、comment)は日本語で書く。code、identifier、command、path、引用した log / error text は原文のまま維持する。",
    ].join("\n"),
  },
  inputsHeading: {
    en: "## Inputs",
    ja: "## 入力",
  },
  stepWorktree: {
    en: (input) =>
      `worktree: ${input.worktreePath} (cwd. base branch: ${input.baseBranch})`,
    ja: (input) =>
      `worktree: ${input.worktreePath} (cwd。base branch: ${input.baseBranch})`,
  },
  stepPromptHeading: {
    en: "## Step prompt (user-configured)",
    ja: "## Step prompt（ユーザー設定）",
  },
  workflowAgentNoteHeading: {
    en: "## Note from the workflow agent",
    ja: "## Workflow agent からの note",
  },
  noneStepPrompt: {
    en: "(none - follow the contract)",
    ja: "(none - contract に従ってください)",
  },
  parentPrompt: {
    en: (input) => [
      "## Run context",
      `run: ${input.runId}`,
      `workflow: ${input.workflowName}`,
      `repo: ${input.repoName} (pass --repo ${input.repoArg} on every lh command)`,
      `issue: #${input.issueNumber}`,
      `pr: #${input.prNumber}`,
      "current step: execute",
      `worktree: . (cwd. base branch: ${input.baseRef})`,
      "",
      "## Instruction",
      "Orchestrate this run through Execute -> Verify as described in your contract.",
      `Decide every transition by observing \`lh workflow step status ${input.runId} --repo ${input.repoArg} --json\` after a background watch task returns an event; task completion, pane output, and PR body markers are never transition facts.`,
      "Start now:",
      `1. Seed <cursor> from the latest id returned by \`lh events --repo ${input.repoArg} --type workflow_run --run ${input.runId} --order desc --limit 1 --json\`; use 0 when no event exists.`,
      `2. Launch the Execute child: \`lh workflow launch-step --repo ${input.repoArg} --run ${input.runId} --step execute\`.`,
      `3. Start \`lh workflow watch --repo ${input.repoArg} --run ${input.runId} --since <cursor> --json\` as a runtime-managed background task and end the model turn while it blocks. Resume only from the task completion notification, then read its JSON result. Runtime-specific tool mechanics belong to the runtime adapter, not this prompt.`,
      "4. On task completion, process the single event in the returned `events` array and re-observe step status for every transition. After processing it, start the returned `next_command` verbatim as the next background watch; do not reconstruct or edit its cursor.",
      `If the parent restarts or loses its cursor, inspect \`lh events --repo ${input.repoArg} --type workflow_run --run ${input.runId} --order asc --json\` and current step status instead of expecting automatic replay.`,
      "Then follow your contract's transition table, rework, and escalation for the remaining steps. Do not invoke slash-style commands.",
      "",
    ],
    ja: (input) => [
      "## Run コンテキスト",
      `run: ${input.runId}`,
      `workflow: ${input.workflowName}`,
      `repo: ${input.repoName} (すべての lh command で --repo ${input.repoArg} を渡してください)`,
      `issue: #${input.issueNumber}`,
      `pr: #${input.prNumber}`,
      "current step: execute",
      `worktree: . (cwd。base branch: ${input.baseRef})`,
      "",
      "## 指示",
      "contract の記述に従い、この run を Execute -> Verify の順に orchestrate してください。",
      `background watch task が event を返した後、\`lh workflow step status ${input.runId} --repo ${input.repoArg} --json\` を観測して各遷移を判断してください。task completion、pane output、PR body marker は遷移の事実ではありません。`,
      "今すぐ開始してください:",
      `1. \`lh events --repo ${input.repoArg} --type workflow_run --run ${input.runId} --order desc --limit 1 --json\` が返す最新 id から <cursor> を seed します。event がなければ 0 を使います。`,
      `2. Execute child を起動します: \`lh workflow launch-step --repo ${input.repoArg} --run ${input.runId} --step execute\`.`,
      `3. \`lh workflow watch --repo ${input.repoArg} --run ${input.runId} --since <cursor> --json\` を runtime-managed background task として開始し、block 中は model turn を終了します。task completion 通知だけを契機に再開し、JSON result を読みます。runtime 固有の tool mechanism はこの prompt ではなく runtime adapter の責務です。`,
      "4. task completion 後、返された `events` array 内の単一 event を処理し、各遷移について step status を再観測します。処理後は返された `next_command` を編集せず、そのまま次の background watch として開始します。cursor を組み立て直しません。",
      `parent restart または cursor 消失時は、自動 replay を期待せず \`lh events --repo ${input.repoArg} --type workflow_run --run ${input.runId} --order asc --json\` と current step status を確認します。`,
      "以後の step では contract の遷移表、rework、escalation に従ってください。slash-style command は呼び出さないでください。",
      "",
    ],
  },
  reviewSubmissionInstruction: {
    en: "do not read the PR",
    ja: "do not read the PR",
  },
  handoffLaunchIntro: {
    en: (step, runId) => `Launch Workflow ${step} step for run #${runId}.`,
    ja: (step, runId) =>
      `Workflow ${step} step を run #${runId} 向けに起動します。`,
  },
  handoffParentNoteHeading: {
    en: "## Note from parent",
    ja: "## Parent からの note",
  },
  handoffSummary: {
    en: (step) => `Launch ${step} step`,
    ja: (step) => `${step} step を起動`,
  },
} satisfies WorkflowMessageCatalog;

export function workflowMessages(
  language: WorkflowContractLanguage,
): WorkflowMessages {
  return {
    contractContext: WORKFLOW_MESSAGE_CATALOG.contractContext[language],
    languageInstruction: WORKFLOW_MESSAGE_CATALOG.languageInstruction[language],
    inputsHeading: WORKFLOW_MESSAGE_CATALOG.inputsHeading[language],
    stepWorktree: WORKFLOW_MESSAGE_CATALOG.stepWorktree[language],
    stepPromptHeading: WORKFLOW_MESSAGE_CATALOG.stepPromptHeading[language],
    workflowAgentNoteHeading:
      WORKFLOW_MESSAGE_CATALOG.workflowAgentNoteHeading[language],
    noneStepPrompt: WORKFLOW_MESSAGE_CATALOG.noneStepPrompt[language],
    parentPrompt: WORKFLOW_MESSAGE_CATALOG.parentPrompt[language],
    reviewSubmissionInstruction:
      WORKFLOW_MESSAGE_CATALOG.reviewSubmissionInstruction[language],
    handoffLaunchIntro: WORKFLOW_MESSAGE_CATALOG.handoffLaunchIntro[language],
    handoffParentNoteHeading:
      WORKFLOW_MESSAGE_CATALOG.handoffParentNoteHeading[language],
    handoffSummary: WORKFLOW_MESSAGE_CATALOG.handoffSummary[language],
  };
}
