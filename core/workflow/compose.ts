import type { WorkflowContractLanguage } from "./contracts.ts";
import { workflowMessages } from "./messages.ts";
import { shellArg } from "./prompts.ts";

export type WorkflowStep = "execute" | "verify";

export const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  "execute",
  "verify",
] as const;

export type WorkflowContractRenderInput = {
  template: string;
  repo: string;
  step: WorkflowStep | "parent";
  run: number;
  worktreePath: string;
  baseBranch: string;
};

/**
 * One pointer given to a step child at launch. Pointers are the only
 * Workflow-specific input vocabulary: references into domain state (issue, PR,
 * review, SHA), never synthesized content.
 */
export type WorkflowInputPointer = {
  label: string;
  value: string;
};

export type WorkflowStepPromptInput = {
  pointers: WorkflowInputPointer[];
  worktreePath?: string;
  baseBranch: string;
  stepPrompt?: string;
  note?: string;
};

export type WorkflowComposedPrompt = {
  systemPrompt: string;
  userPrompt: string;
  pointers: WorkflowInputPointer[];
  stepPrompt: string;
  note?: string;
};

// Injected into every rendered contract (parent and each step child) so the whole run —
// including step relaunches after rework — carries the same language instruction (#1205).
export const WORKFLOW_LANGUAGE_INSTRUCTION =
  workflowMessages("en").languageInstruction;

export function renderWorkflowContract(
  input: WorkflowContractRenderInput,
  language: WorkflowContractLanguage,
): string {
  const messages = workflowMessages(language);
  const replacements = {
    repo: shellArg(input.repo),
    step: input.step,
    run: String(input.run),
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
  };
  const rendered = input.template.replace(
    /\{\{(repo|step|run|worktreePath|baseBranch)\}\}/g,
    (_, key: keyof typeof replacements) => replacements[key],
  );
  return [
    ...messages.contractContext(input),
    "",
    messages.languageInstruction,
    "",
    rendered,
  ].join("\n");
}

export function composeWorkflowStepPrompt(
  input: WorkflowStepPromptInput,
  language: WorkflowContractLanguage,
): WorkflowComposedPrompt {
  const messages = workflowMessages(language);
  const stepPrompt =
    normalizeOptionalText(input.stepPrompt) ?? messages.noneStepPrompt;
  const note = normalizeOptionalText(input.note);
  const pointerLines = input.pointers.map(
    (pointer) => `- ${pointer.label}: ${pointer.value}`,
  );
  const sections = [
    messages.inputsHeading,
    ...pointerLines,
    messages.stepWorktree({
      worktreePath: input.worktreePath ?? ".",
      baseBranch: input.baseBranch,
    }),
    "",
    messages.stepPromptHeading,
    stepPrompt,
  ];

  if (note) {
    sections.push("", messages.workflowAgentNoteHeading, note);
  }

  return {
    systemPrompt: "",
    userPrompt: `${sections.join("\n")}\n`,
    pointers: input.pointers,
    stepPrompt,
    note,
  };
}

export function composeWorkflowLaunchPrompt(
  contract: WorkflowContractRenderInput,
  prompt: WorkflowStepPromptInput,
  language: WorkflowContractLanguage,
): WorkflowComposedPrompt {
  return {
    ...composeWorkflowStepPrompt(prompt, language),
    systemPrompt: renderWorkflowContract(contract, language),
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
