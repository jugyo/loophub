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
      "Decide every transition from the `action` and `observed` state returned by `lh workflow next`; command completion, pane output, and PR body markers are never transition facts.",
      "Start now:",
      `1. Launch the Execute child: \`lh workflow launch-step --repo ${input.repoArg} --run ${input.runId} --step execute\`.`,
      `2. Start \`lh workflow next ${input.runId} --repo ${input.repoArg} --watch --json\` with \`exec_command\`. If it returns a \`session_id\` before completion, wait with \`write_stdin\` using the same session, empty input, and a long yield. Do not emit a final parent response while waiting.`,
      "3. On completion, execute the returned action as your contract describes, then start the same `next --watch` command again with `exec_command`. The command owns event delivery and where to resume, so never seed or acknowledge a cursor.",
      "Then follow your contract's actions, rework, and escalation for the remaining steps. Do not invoke slash-style commands.",
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
      "各遷移は `lh workflow next` が返す `action` と `observed` から判断してください。command completion、pane output、PR body marker は遷移の事実ではありません。",
      "今すぐ開始してください:",
      `1. Execute child を起動します: \`lh workflow launch-step --repo ${input.repoArg} --run ${input.runId} --step execute\`.`,
      `2. \`lh workflow next ${input.runId} --repo ${input.repoArg} --watch --json\` を \`exec_command\` で開始します。完了前に \`session_id\` が返った場合は、同じ session、空入力、長い yield の \`write_stdin\` で待ちます。待機中は parent の最終応答を出しません。`,
      "3. 完了後、返された action を contract の手順どおり実行し、同じ `next --watch` command を再度 `exec_command` で開始します。event の受信と再開位置はこの command が管理するため、cursor を seed・acknowledge しません。",
      "以後の step では contract の actions、rework、escalation に従ってください。slash-style command は呼び出さないでください。",
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
