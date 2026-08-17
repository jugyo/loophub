import type { WorkflowStep } from "./compose.ts";
import type { WorkflowContractLanguage } from "./contracts.ts";
import { workflowMessages } from "./messages.ts";

export function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Strip control characters (incl. newlines) and Unicode bidi-override/isolate chars, then collapse
// whitespace, so a value shown as prose in an agent prompt cannot inject fake prompt structure or
// spoof the displayed text. Used for the human/agent-readable copies of the repo/workflow names; the
// shell-quoted forms passed to commands keep the real value. The unsafe-char class mirrors
// normalizeAgentName in core/terminal/terminal-launch.ts (C0/C1 controls + DEL + bidi controls).
export function inlineText(value: string): string {
  return value
    .replace(/[\x00-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parentUserPrompt(
  input: {
    runId: number;
    repoName: string;
    workflowName: string;
    issueNumber: number;
    prNumber: number;
    baseRef: string;
  },
  language: WorkflowContractLanguage,
): string {
  const repoArg = shellArg(input.repoName);
  return workflowMessages(language)
    .parentPrompt({
      ...input,
      repoName: inlineText(input.repoName),
      repoArg,
      workflowName: inlineText(input.workflowName),
    })
    .join("\n");
}

export function stepContractForLaunch(
  _step: WorkflowStep,
  template: string,
): string {
  return template;
}

export function workflowStepPrompt(
  workflow: { [K in `${WorkflowStep}_prompt`]: string },
  step: WorkflowStep,
): string {
  return workflow[`${step}_prompt` as const];
}
