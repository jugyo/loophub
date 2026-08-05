import { expect, test } from "vitest";
import { composeWorkflowStepPrompt, WORKFLOW_STEPS } from "./compose.ts";
import type { WorkflowContractLanguage } from "./contracts.ts";
import { workflowStepPrompt } from "./prompts.ts";
import {
  WORKFLOW_TEMPLATES_BY_LANGUAGE,
  workflowTemplates,
} from "./workflow-templates.ts";

const LANGUAGES = Object.keys(
  WORKFLOW_TEMPLATES_BY_LANGUAGE,
) as WorkflowContractLanguage[];

test("every contract language ships the same four templates under English names", () => {
  // The names label the loop a template sets up, so they stay stable across languages; only the
  // prose follows the contract language.
  expect(LANGUAGES).toEqual(["en", "ja"]);
  for (const language of LANGUAGES) {
    const templates = workflowTemplates(language);
    expect(templates.map((template) => template.name)).toEqual([
      "Build",
      "Design",
      "Investigate",
      "Research",
    ]);
  }
});

test("unknown languages fall back to the English templates", () => {
  expect(workflowTemplates(undefined)).toBe(workflowTemplates("en"));
  expect(workflowTemplates("fr")).toBe(workflowTemplates("en"));
  expect(workflowTemplates("ja")).not.toBe(workflowTemplates("en"));
});

test("every template carries a description and both step prompts", () => {
  for (const language of LANGUAGES) {
    for (const template of workflowTemplates(language)) {
      expect(template.description.trim()).not.toBe("");
      expect(template.execute_prompt.trim()).not.toBe("");
      expect(template.verify_prompt.trim()).not.toBe("");
      // Workflow names are stored with a 64-character limit (core/service/workflows.ts).
      expect(template.name.length).toBeLessThanOrEqual(64);
    }
  }
});

test("each language's prose is written in that language", () => {
  const japanese = /[぀-ヿ一-龯]/;
  for (const template of workflowTemplates("ja")) {
    expect(template.description).toMatch(japanese);
    expect(template.execute_prompt).toMatch(japanese);
    expect(template.verify_prompt).toMatch(japanese);
  }
  for (const template of workflowTemplates("en")) {
    expect(template.description).not.toMatch(japanese);
    expect(template.execute_prompt).not.toMatch(japanese);
    expect(template.verify_prompt).not.toMatch(japanese);
  }
});

test("template bodies stay generic across repositories and house conventions", () => {
  // A template ships with LoopHub, so it must not name one repository's files, tooling, or team
  // conventions the way a hand-written workflow prompt may.
  const repositorySpecific = [
    "AGENTS.md",
    "CLAUDE.md",
    "loophub",
    "npm run",
    "package.json",
    "Playwright",
    "docs/",
  ];
  for (const language of LANGUAGES) {
    for (const template of workflowTemplates(language)) {
      const body = `${template.description}\n${template.execute_prompt}\n${template.verify_prompt}`;
      for (const term of repositorySpecific) {
        expect(body.toLowerCase()).not.toContain(term.toLowerCase());
      }
    }
  }
});

test("a template's prompts reach the step children a run launches", () => {
  // A workflow created from a template is an ordinary workflow row, so a run picks up its prompts
  // through the same selection and composition a hand-written workflow uses.
  for (const language of LANGUAGES) {
    for (const template of workflowTemplates(language)) {
      for (const step of WORKFLOW_STEPS) {
        const authored = workflowStepPrompt(template, step);
        const composed = composeWorkflowStepPrompt(
          {
            pointers: [{ label: "issue", value: "#1" }],
            baseBranch: "main",
            stepPrompt: authored,
          },
          language,
        );
        expect(composed.stepPrompt).toBe(authored.trim());
        expect(composed.userPrompt).toContain(authored.trim());
      }
    }
  }
});

test("template bodies leave the fixed contract obligations to the contracts", () => {
  // The Execute/Verify contracts already command the `lh` operations; a step prompt is additive
  // guidance, so repeating them here would only drift from the contract.
  for (const language of LANGUAGES) {
    for (const template of workflowTemplates(language)) {
      const body = `${template.execute_prompt}\n${template.verify_prompt}`;
      expect(body).not.toContain("lh ");
      expect(body).not.toContain("turn done");
    }
  }
});
