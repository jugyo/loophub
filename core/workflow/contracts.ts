import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_STEPS, type WorkflowStep } from "./compose.ts";

export type WorkflowContract = WorkflowStep | "parent";
export const WORKFLOW_CONTRACT_LANGUAGES = ["en", "ja"] as const;
export type WorkflowContractLanguage =
  (typeof WORKFLOW_CONTRACT_LANGUAGES)[number];

const CONTRACT_DIR = join(import.meta.dirname, "contracts");

/** Read a fixed workflow contract from the canonical Markdown source used at launch time. */
export function workflowContractText(
  contract: WorkflowContract,
  language: WorkflowContractLanguage = "en",
): string {
  const suffix = language === "en" ? "" : `.${language}`;
  return readFileSync(join(CONTRACT_DIR, `${contract}${suffix}.md`), "utf8");
}

/** Read the fixed step contracts exposed by the workflow settings UI. */
export function workflowStepContracts(
  language: WorkflowContractLanguage = "en",
): Record<WorkflowStep, string> {
  return Object.fromEntries(
    WORKFLOW_STEPS.map((step) => [step, workflowContractText(step, language)]),
  ) as Record<WorkflowStep, string>;
}
