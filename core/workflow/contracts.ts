import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_STEPS, type WorkflowStep } from "./compose.ts";

export type WorkflowContract = WorkflowStep | "parent";

const CONTRACT_DIR = join(import.meta.dirname, "contracts");

/** Read a fixed workflow contract from the canonical Markdown source used at launch time. */
export function workflowContractText(contract: WorkflowContract): string {
  return readFileSync(join(CONTRACT_DIR, `${contract}.md`), "utf8");
}

/** Read the four step contracts exposed by the workflow settings UI. */
export function workflowStepContracts(): Record<WorkflowStep, string> {
  return Object.fromEntries(
    WORKFLOW_STEPS.map((step) => [step, workflowContractText(step)]),
  ) as Record<WorkflowStep, string>;
}
