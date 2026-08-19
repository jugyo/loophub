import { expect, test } from "vitest";
import { prTestMapPrompt } from "./pr-test-map-prompt.ts";

test("unknown languages fall back to the English prompt", () => {
  const en = prTestMapPrompt({ repo: "me/proj", prNumber: 7 });
  expect(
    prTestMapPrompt({ repo: "me/proj", prNumber: 7, language: "fr" }),
  ).toBe(en);
  expect(
    prTestMapPrompt({ repo: "me/proj", prNumber: 7, language: undefined }),
  ).toBe(en);
});

test("interpolates the repo and PR number into the lh commands", () => {
  for (const language of ["en", "ja"] as const) {
    const prompt = prTestMapPrompt({
      repo: "me/proj",
      prNumber: 42,
      language,
    });
    expect(prompt).toContain("lh pr view 42 --repo me/proj --json");
    expect(prompt).toContain("lh pr test-map create 42 --repo me/proj");
  }
});

test("keeps the document's keys in English in both languages", () => {
  for (const language of ["en", "ja"] as const) {
    const prompt = prTestMapPrompt({ repo: "me/proj", prNumber: 1, language });
    for (const key of [
      '"version": 1',
      '"summary"',
      '"files"',
      '"tests"',
      '"suites"',
      '"title"',
      '"code"',
      '"target"',
    ]) {
      expect(prompt).toContain(key);
    }
  }
});

// The excerpts are the whole reason a reader can trust the map, so both languages have to say
// where they come from.
test("requires the code excerpts to be copied verbatim from the files at the head", () => {
  const en = prTestMapPrompt({ repo: "me/proj", prNumber: 1, language: "en" });
  expect(en).toContain("copied verbatim out of the real files");
  expect(en).toContain("git show <head sha>:<path>");
  const ja = prTestMapPrompt({ repo: "me/proj", prNumber: 1, language: "ja" });
  expect(ja).toContain("実ファイルから逐語的にコピー");
  expect(ja).toContain("git show <head sha>:<path>");
});

test("says every changed test file belongs in the document", () => {
  expect(
    prTestMapPrompt({ repo: "me/proj", prNumber: 1, language: "en" }),
  ).toContain("Every changed test file belongs in `files`");
  expect(
    prTestMapPrompt({ repo: "me/proj", prNumber: 1, language: "ja" }),
  ).toContain("変更されたテストファイルは 1 つ残らず `files` に入れてください");
});

test("instructs writing the prose in the configured language", () => {
  expect(
    prTestMapPrompt({ repo: "me/proj", prNumber: 1, language: "en" }),
  ).toContain(
    "write the prose values in the language selected in the application, which is English",
  );
  expect(
    prTestMapPrompt({ repo: "me/proj", prNumber: 1, language: "ja" }),
  ).toContain(
    "などの散文はアプリケーションで選択されている言語に従って日本語で記述",
  );
});
