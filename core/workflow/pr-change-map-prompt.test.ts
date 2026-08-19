import { expect, test } from "vitest";
import { CHANGE_MAP_MAX_CATEGORIES } from "../change-map-document.ts";
import { prChangeMapPrompt } from "./pr-change-map-prompt.ts";

test("unknown languages fall back to the English prompt", () => {
  const en = prChangeMapPrompt({ repo: "me/proj", prNumber: 7 });
  expect(
    prChangeMapPrompt({ repo: "me/proj", prNumber: 7, language: "fr" }),
  ).toBe(en);
  expect(
    prChangeMapPrompt({ repo: "me/proj", prNumber: 7, language: undefined }),
  ).toBe(en);
});

test("interpolates the repo and PR number into the lh commands", () => {
  for (const language of ["en", "ja"] as const) {
    const prompt = prChangeMapPrompt({
      repo: "me/proj",
      prNumber: 42,
      language,
    });
    expect(prompt).toContain("lh pr view 42 --repo me/proj --json");
    expect(prompt).toContain("lh pr map create 42 --repo me/proj");
  }
});

test("keeps the document's keys in English in both languages", () => {
  for (const language of ["en", "ja"] as const) {
    const prompt = prChangeMapPrompt({
      repo: "me/proj",
      prNumber: 1,
      language,
    });
    for (const key of [
      '"version": 1',
      '"summary"',
      '"categories"',
      '"changes"',
      '"kind"',
      '"files"',
      '"tests"',
      '"risk"',
    ]) {
      expect(prompt).toContain(key);
    }
  }
});

// The cap only works if the prompt says the same number the service enforces.
test("states the category ceiling from the shared constant", () => {
  expect(
    prChangeMapPrompt({ repo: "me/proj", prNumber: 1, language: "en" }),
  ).toContain(`At most ${CHANGE_MAP_MAX_CATEGORIES} categories`);
  expect(
    prChangeMapPrompt({ repo: "me/proj", prNumber: 1, language: "ja" }),
  ).toContain(`カテゴリは最大 ${CHANGE_MAP_MAX_CATEGORIES} 個`);
});

test("warns against grouping by directory and against a catch-all", () => {
  const en = prChangeMapPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "en",
  });
  expect(en).toContain("Do not group by directory");
  expect(en).toContain('Do not create a "Misc" or "Other" catch-all');
  const ja = prChangeMapPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "ja",
  });
  expect(ja).toContain("ディレクトリ構造をなぞった分類にしないでください");
  expect(ja).toContain("捨て場カテゴリを作らないでください");
});

test("instructs writing the prose in the configured language", () => {
  const en = prChangeMapPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "en",
  });
  expect(en).toContain(
    "write the prose values in the language selected in the application, which is English",
  );
  const ja = prChangeMapPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "ja",
  });
  expect(ja).toContain(
    "値の散文はアプリケーションで選択されている言語に従って日本語で記述",
  );
});

test("states the coverage requirement and where paths must appear", () => {
  const en = prChangeMapPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "en",
  });
  expect(en).toContain("no diff may be unreachable");
  expect(en).toContain(
    "Every changed file must appear in some change's `files`",
  );
  const ja = prChangeMapPrompt({
    repo: "me/proj",
    prNumber: 1,
    language: "ja",
  });
  expect(ja).toContain("change map から辿れない diff があってはなりません");
  expect(ja).toContain("いずれかの change の `files` に入れてください");
});
