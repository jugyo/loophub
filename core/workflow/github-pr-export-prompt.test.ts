import { expect, test } from "vitest";
import { githubPrExportPrompt } from "./github-pr-export-prompt.ts";

test("unknown languages fall back to the English prompt", () => {
  const en = githubPrExportPrompt({ repo: "me/proj", prNumber: 7 });
  expect(
    githubPrExportPrompt({ repo: "me/proj", prNumber: 7, language: "fr" }),
  ).toBe(en);
  expect(
    githubPrExportPrompt({ repo: "me/proj", prNumber: 7, language: undefined }),
  ).toBe(en);
});

test("interpolates the repo and PR number into the lh commands", () => {
  for (const language of ["en", "ja"] as const) {
    const prompt = githubPrExportPrompt({
      repo: "me/proj",
      prNumber: 42,
      language,
    });
    expect(prompt).toContain("lh pr view 42 --repo me/proj --json");
    expect(prompt).toContain("lh pr create-github-pr 42 --repo me/proj");
  }
});

test("instructs writing the title/body in the configured language", () => {
  const en = githubPrExportPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "en",
  });
  expect(en).toContain("write their natural-language content in English");
  expect(en).toContain("Do not infer a different language");
  const ja = githubPrExportPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "ja",
  });
  expect(ja).toContain("自然言語部分は日本語で記述");
  expect(ja).toContain("別の言語を推測しない");
});

test("preserves source-like content in both configured languages", () => {
  const en = githubPrExportPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "en",
  });
  expect(en).toContain(
    "Keep code, identifiers, commands, paths, and quoted log or error text in their original form.",
  );

  const ja = githubPrExportPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "ja",
  });
  expect(ja).toContain(
    "code、identifier、command、path、引用した log / error text は翻訳せず原文のまま維持してください。",
  );
});

test("keeps the double-create guard and the post-create verification GET", () => {
  for (const [language, phrases] of [
    [
      "en",
      [
        "github_pull",
        "double-create guard",
        "After creation, GET the PR again",
      ],
    ],
    ["ja", ["github_pull", "二重作成防止", "GET して"]],
  ] as const) {
    const prompt = githubPrExportPrompt({
      repo: "me/proj",
      prNumber: 3,
      language,
    });
    for (const phrase of phrases) expect(prompt).toContain(phrase);
  }
});

test("does not reference the retired lh-create-github-pr skill", () => {
  for (const language of ["en", "ja"] as const) {
    expect(
      githubPrExportPrompt({ repo: "me/proj", prNumber: 5, language }),
    ).not.toContain("/lh-create-github-pr");
  }
});
