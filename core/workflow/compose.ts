export type WorkflowStep = "plan" | "execute" | "verify" | "reflect";

export const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  "plan",
  "execute",
  "verify",
  "reflect",
] as const;

export type WorkflowContractRenderInput = {
  template: string;
  step: WorkflowStep | "parent";
  worktreePath: string;
  baseBranch: string;
};

export type WorkflowInputFileRef = {
  path: string;
  description: string;
};

export type WorkflowStepPromptInput = {
  inputFiles: WorkflowInputFileRef[];
  worktreePath?: string;
  baseBranch: string;
  stepPrompt?: string;
  note?: string;
};

export type WorkflowComposedPrompt = {
  systemPrompt: string;
  userPrompt: string;
  inputFiles: WorkflowInputFileRef[];
  stepPrompt: string;
  note?: string;
};

const NONE_STEP_PROMPT = "(none - follow the contract)";

export function renderWorkflowContract(
  input: WorkflowContractRenderInput,
): string {
  const rendered = input.template
    .replaceAll("{{step}}", input.step)
    .replaceAll("{{worktreePath}}", input.worktreePath)
    .replaceAll("{{baseBranch}}", input.baseBranch);
  return [
    "## Workflow contract context",
    `step: ${input.step}`,
    `worktree: ${input.worktreePath}`,
    `base branch: ${input.baseBranch}`,
    "",
    rendered,
  ].join("\n");
}

export function composeWorkflowStepPrompt(
  input: WorkflowStepPromptInput,
): WorkflowComposedPrompt {
  const stepPrompt =
    normalizeOptionalText(input.stepPrompt) ?? NONE_STEP_PROMPT;
  const note = normalizeOptionalText(input.note);
  const inputLines = input.inputFiles.map(
    (file) => `- ${file.path} - ${file.description}`,
  );
  const sections = [
    "## Inputs",
    ...inputLines,
    `worktree: ${input.worktreePath ?? "."} (cwd. base branch: ${input.baseBranch})`,
    "",
    "## Step prompt (user-configured)",
    stepPrompt,
  ];

  if (note) {
    sections.push("", "## Note from the workflow agent", note);
  }

  return {
    systemPrompt: "",
    userPrompt: `${sections.join("\n")}\n`,
    inputFiles: input.inputFiles,
    stepPrompt,
    note,
  };
}

export function composeWorkflowLaunchPrompt(
  contract: WorkflowContractRenderInput,
  prompt: WorkflowStepPromptInput,
): WorkflowComposedPrompt {
  return {
    ...composeWorkflowStepPrompt(prompt),
    systemPrompt: renderWorkflowContract(contract),
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
