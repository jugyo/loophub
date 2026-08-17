import { expect, test } from "vitest";
import { issueCreatePrompt } from "./issue-create-prompt.ts";

test("unknown languages fall back to the English prompt", () => {
  expect(issueCreatePrompt(undefined)).toBe(issueCreatePrompt("en"));
  expect(issueCreatePrompt("fr")).toBe(issueCreatePrompt("en"));
});

test("adds the parent issue instruction in the selected language", () => {
  expect(issueCreatePrompt("en", 12)).toContain(
    "Create it as sub issue #12, at a granularity that fits within the parent's acceptance criteria.",
  );
  expect(issueCreatePrompt("ja", 12)).toContain(
    "#12 の sub issue として、親の acceptance criteria に収まる粒度で起票してください。",
  );
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

test("both prompts require one-at-a-time questions with choices before filing", () => {
  for (const language of ["en", "ja"]) {
    const prompt = issueCreatePrompt(language);
    const question =
      language === "en"
        ? "single highest-impact question first"
        : "最も影響の大きい質問を一問ずつ";
    const choices = language === "en" ? "concrete choices" : "具体的な選択肢";
    const wait =
      language === "en"
        ? "wait for the user's answer before asking another question"
        : "回答を待ってから次の質問";

    expect(prompt).toContain(question);
    expect(prompt).toContain(choices);
    expect(prompt).toContain(wait);
  }
});

test("both prompts allow users to cut questioning short and file gathered context", () => {
  for (const language of ["en", "ja"]) {
    const prompt = issueCreatePrompt(language);
    const stop =
      language === "en"
        ? "clearly cuts the questioning short"
        : "深掘りを明確に止める指示";
    const gathered =
      language === "en" ? "file the current draft" : "現在の草案で起票";

    expect(prompt).toContain(stop);
    expect(prompt).toContain(gathered);
  }
});

test("both prompts build a draft from the request before asking questions", () => {
  for (const language of ["en", "ja"]) {
    const prompt = issueCreatePrompt(language);
    const draft =
      language === "en"
        ? "turn the request into a draft issue"
        : "issue の草案を作ってください";
    const ambiguity =
      language === "en"
        ? "could materially change the implementation"
        : "実装の内容や結果の検証方法を大きく変えうる曖昧さや不足";

    expect(prompt).toContain(draft);
    expect(prompt).toContain(ambiguity);
  }
});
