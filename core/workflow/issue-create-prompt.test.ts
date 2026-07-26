import { expect, test } from "vitest";
import { issueCreatePrompt } from "./issue-create-prompt.ts";

test("unknown languages fall back to the English prompt", () => {
  expect(issueCreatePrompt(undefined)).toBe(issueCreatePrompt("en"));
  expect(issueCreatePrompt("fr")).toBe(issueCreatePrompt("en"));
});

test("both prompts state the responsibility boundary before the filing instructions", () => {
  for (const language of ["en", "ja"]) {
    const prompt = issueCreatePrompt(language);
    const boundary =
      language === "en"
        ? "never write the implementation"
        : "実装そのものは決して行いません";
    const create = "lh issue create";
    expect(prompt).toContain(boundary);
    expect(prompt.indexOf(boundary)).toBeLessThan(prompt.indexOf(create));
  }
});

test("both prompts defer CLI operation details to issue create help", () => {
  for (const language of ["en", "ja"]) {
    const prompt = issueCreatePrompt(language);
    const help = "lh issue create --help";
    const create = "lh issue create`";

    expect(prompt).toContain(help);
    expect(prompt.indexOf(help)).toBeLessThan(prompt.lastIndexOf(create));
    expect(prompt).not.toContain("--ac");
    expect(prompt).not.toContain("--workspace");
    expect(prompt).not.toContain("--target-branch");
  }
});

test("both prompts keep the existing filing instructions", () => {
  for (const [language, phrases] of [
    [
      "en",
      [
        "acceptance criteria",
        "open question",
        "duplicate issues",
        "lh issue create",
        "issue number",
      ],
    ],
    [
      "ja",
      [
        "acceptance criteria",
        "open question",
        "重複しそうな issue",
        "lh issue create",
        "issue 番号",
      ],
    ],
  ] as const) {
    const prompt = issueCreatePrompt(language);
    for (const phrase of phrases) expect(prompt).toContain(phrase);
  }
});
