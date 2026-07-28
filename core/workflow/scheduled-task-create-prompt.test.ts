import { expect, test } from "vitest";
import { scheduledTaskCreatePrompt } from "./scheduled-task-create-prompt.ts";

test("unknown languages fall back to the English prompt", () => {
  expect(scheduledTaskCreatePrompt(undefined)).toBe(
    scheduledTaskCreatePrompt("en"),
  );
  expect(scheduledTaskCreatePrompt("fr")).toBe(scheduledTaskCreatePrompt("en"));
});

test("both prompts defer operation details to the installed CLI help", () => {
  for (const language of ["en", "ja"]) {
    const prompt = scheduledTaskCreatePrompt(language);
    expect(prompt).toContain("lh scheduled-task create --help");
    expect(prompt).toContain("lh scheduled-task create");
  }
});

test("both prompts stop after creating the task", () => {
  expect(scheduledTaskCreatePrompt("en")).toContain(
    "Report the created task id and stop",
  );
  expect(scheduledTaskCreatePrompt("ja")).toContain(
    "作成した task id を報告して停止",
  );
});
