export type PevrStep = "plan" | "execute" | "verify" | "reflect";

export const PEVR_STEPS: readonly PevrStep[] = [
  "plan",
  "execute",
  "verify",
  "reflect",
] as const;

export type PevrContractRenderInput = {
  template: string;
  step: PevrStep | "parent";
  worktreePath: string;
  baseBranch: string;
};

export type PevrInputFileRef = {
  path: string;
  description: string;
};

export type PevrStepPromptInput = {
  inputFiles: PevrInputFileRef[];
  worktreePath?: string;
  baseBranch: string;
  stepPrompt?: string;
  note?: string;
};

export type PevrComposedPrompt = {
  systemPrompt: string;
  userPrompt: string;
  inputFiles: PevrInputFileRef[];
  stepPrompt: string;
  note?: string;
};

const NONE_STEP_PROMPT = "(none - follow the contract)";

export function renderPevrContract(input: PevrContractRenderInput): string {
  const rendered = input.template
    .replaceAll("{{step}}", input.step)
    .replaceAll("{{worktreePath}}", input.worktreePath)
    .replaceAll("{{baseBranch}}", input.baseBranch);
  return [
    "## PEVR contract context",
    `step: ${input.step}`,
    `worktree: ${input.worktreePath}`,
    `base branch: ${input.baseBranch}`,
    "",
    rendered,
  ].join("\n");
}

export function composePevrStepPrompt(
  input: PevrStepPromptInput,
): PevrComposedPrompt {
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

export function composePevrLaunchPrompt(
  contract: PevrContractRenderInput,
  prompt: PevrStepPromptInput,
): PevrComposedPrompt {
  return {
    ...composePevrStepPrompt(prompt),
    systemPrompt: renderPevrContract(contract),
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
