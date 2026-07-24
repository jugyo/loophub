import { expect, test } from "vitest";
import { workflowCreatePrompt } from "./workflow-create-prompt.ts";

test("unknown languages fall back to the English prompt", () => {
  expect(workflowCreatePrompt(undefined)).toBe(workflowCreatePrompt("en"));
  expect(workflowCreatePrompt("fr")).toBe(workflowCreatePrompt("en"));
});

test("both prompts state the responsibility boundary before the create instructions", () => {
  for (const language of ["en", "ja"]) {
    const prompt = workflowCreatePrompt(language);
    const boundary =
      language === "en"
        ? "never run a workflow or implement anything"
        : "workflow の実行や実装そのものは決して行いません";
    const create = "lh workflow create";
    expect(prompt).toContain(boundary);
    expect(prompt.indexOf(boundary)).toBeLessThan(prompt.indexOf(create));
  }
});

test("both prompts keep the workflow-create instructions", () => {
  for (const [language, phrases] of [
    [
      "en",
      [
        "execute prompt",
        "verify prompt",
        "open question",
        "lh workflow create",
      ],
    ],
    [
      "ja",
      [
        "execute prompt",
        "verify prompt",
        "open question",
        "lh workflow create",
      ],
    ],
  ] as const) {
    const prompt = workflowCreatePrompt(language);
    for (const phrase of phrases) expect(prompt).toContain(phrase);
  }
});
