import { ensureHomeDir, writeHomeFile } from "../home-files.ts";
import type { WorkflowStep } from "./compose.ts";

// Per-run files under LOOPHUB_HOME that a Workflow launch hands to an agent: the contract it is
// started with as a system prompt, and the user prompt its command line reads back. Only the
// writers are exported: every path this module touches is derived from the run id, so no caller can
// aim a write elsewhere.

function ensureRunDir(runId: number): string {
  return ensureHomeDir("runs", "workflow", String(runId));
}

function writeRunFile(runId: number, name: string, text: string): string {
  return writeHomeFile(ensureRunDir(runId), name, text);
}

function ensureStepLaunchDir(runId: number, sessionId: string): string {
  if (!/^[0-9a-f-]+$/iu.test(sessionId)) {
    throw new Error(
      "Workflow launch session id contains unsafe path characters",
    );
  }
  return ensureHomeDir(
    "runs",
    "workflow",
    String(runId),
    "launches",
    sessionId,
  );
}

export function writeParentContract(runId: number, text: string): string {
  return writeRunFile(runId, "parent-contract.md", text);
}

export function writeStepContract(
  runId: number,
  step: WorkflowStep,
  text: string,
): string {
  return writeRunFile(runId, `${step}-contract.md`, text);
}

export function writeStepLaunchContract(
  runId: number,
  sessionId: string,
  step: WorkflowStep,
  text: string,
): string {
  return writeHomeFile(
    ensureStepLaunchDir(runId, sessionId),
    `${step}-contract.md`,
    text,
  );
}

// The positional prompt the launch's command line reads back with `"$(cat …)"`, rather than
// carrying inline: a rendered prompt is multi-KB and multi-line, which would bury the pane's
// scrollback under the text of the command that started the agent.
export function writeParentPrompt(runId: number, text: string): string {
  return writeRunFile(runId, "parent-prompt.md", text);
}

export function writeStepPrompt(
  runId: number,
  step: WorkflowStep,
  text: string,
): string {
  return writeRunFile(runId, `${step}-prompt.md`, text);
}

export function writeStepLaunchPrompt(
  runId: number,
  sessionId: string,
  step: WorkflowStep,
  text: string,
): string {
  return writeHomeFile(
    ensureStepLaunchDir(runId, sessionId),
    `${step}-prompt.md`,
    text,
  );
}
