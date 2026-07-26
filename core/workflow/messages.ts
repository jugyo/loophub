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
      `Start with \`lh workflow next ${input.runId} --repo ${input.repoArg} --json\`, execute its structured \`instructions\`, then follow the contract's watch loop. Do not invoke slash-style commands.`,
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
      `\`lh workflow next ${input.runId} --repo ${input.repoArg} --json\` から開始し、返された構造化 \`instructions\` を実行してから contract の watch loop に従ってください。slash-style command は呼び出さないでください。`,
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
