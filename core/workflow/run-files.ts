import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.ts";
import { ServiceError } from "../errors.ts";
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

function runFilePath(runId: number, name: string): string {
  return join(configDir(), "runs", "workflow", String(runId), name);
}

function readRunFile(runId: number, name: string): string {
  return readFileSync(runFilePath(runId, name), "utf8");
}

function simpleFileName(name: string): string {
  if (!name || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new ServiceError(
      422,
      "workflow run file name must be a simple file name",
    );
  }
  return name;
}

export function workflowManifestPath(runId: number): string {
  return runFilePath(runId, "manifest.json");
}

export function writeWorkflowManifest(runId: number, text: string): string {
  return writeRunFile(runId, "manifest.json", text);
}

export function readWorkflowManifest(runId: number): string {
  return readFileSync(workflowManifestPath(runId), "utf8");
}

export function writeStepPromptSidecar(
  runId: number,
  step: WorkflowStep,
  text: string,
): string {
  return writeRunFile(runId, `${step}-step-prompt.md`, text);
}

export function readStepPromptSidecar(runId: number, name: string): string {
  return readRunFile(runId, simpleFileName(name));
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
