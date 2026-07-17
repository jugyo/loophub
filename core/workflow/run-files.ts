import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDir } from "../config.ts";
import { ServiceError } from "../errors.ts";
import type { WorkflowStep } from "./compose.ts";

// Per-run files under LOOPHUB_HOME that a Workflow launch hands to an agent as its system prompt.
// Only the contract writers are exported: every path this module touches is derived from the run
// id, so no caller can aim a write elsewhere.

function runDir(runId: number): string {
  return join(configDir(), "runs", "workflow", String(runId));
}

function assertNotSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new ServiceError(
      422,
      `Workflow run path must not be a symlink: ${path}`,
    );
  }
}

function ensureRunDir(runId: number): string {
  const dir = runDir(runId);
  for (const path of [
    join(configDir(), "runs"),
    join(configDir(), "runs", "workflow"),
    dir,
  ]) {
    try {
      assertNotSymlink(path);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      mkdirSync(path);
      assertNotSymlink(path);
    }
  }
  return dir;
}

function writeRunFile(runId: number, name: string, text: string): string {
  const dir = ensureRunDir(runId);
  const path = join(dir, name);
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return path;
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
