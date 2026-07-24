import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_STEPS, type WorkflowStep } from "./compose.ts";

export type WorkflowContract = WorkflowStep | "parent";
/** Every fixed contract of a run, in the order the run uses them. */
export const WORKFLOW_CONTRACTS: readonly WorkflowContract[] = [
  "parent",
  ...WORKFLOW_STEPS,
];
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

/** Read the fixed contracts exposed by the workflow settings UI. */
export function workflowContracts(
  language: WorkflowContractLanguage = "en",
): Record<WorkflowContract, string> {
  return Object.fromEntries(
    WORKFLOW_CONTRACTS.map((contract) => [
      contract,
      workflowContractText(contract, language),
    ]),
  ) as Record<WorkflowContract, string>;
}
