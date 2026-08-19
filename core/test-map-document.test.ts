import { expect, test } from "vitest";
import {
  isTestFilePath,
  parseTestMapDocument,
  parseTestMapDocumentText,
  TestMapDocumentError,
  testMapDocumentPaths,
  testMapMarkdown,
  testMapTestCount,
} from "./test-map-document.ts";

const oneTest = (overrides: Record<string, unknown> = {}) => ({
  suites: ["parseTestMapDocument"],
  title: "rejects a document with no files",
  summary: "An empty document cannot be read as a listing of tests.",
  code: "test('x', () => {\n  expect(1).toBe(1);\n});",
  ...overrides,
});

const doc = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  summary: "Covers the document parser",
  files: [{ path: "core/test-map-document.test.ts", tests: [oneTest()] }],
  ...overrides,
});

test("a well-formed document parses, with its prose trimmed", () => {
  const parsed = parseTestMapDocument(doc({ summary: "  Covers it  " }));
  expect(parsed.summary).toBe("Covers it");
  expect(parsed.files[0].tests[0].title).toBe(
    "rejects a document with no files",
  );
  expect(parsed.files[0].tests[0].target).toBeUndefined();
});

// The excerpt is the one thing that must survive untouched: its indentation is part of what makes
// it recognizable as the code that is actually in the file.
test("a code excerpt keeps its indentation, losing only the blank lines around it", () => {
  const parsed = parseTestMapDocument(
    doc({
      files: [
        {
          path: "a.test.ts",
          tests: [
            oneTest({ code: "\ntest('x', () => {\n    body();\n});\n\n" }),
          ],
        },
      ],
    }),
  );
  expect(parsed.files[0].tests[0].code).toBe(
    "test('x', () => {\n    body();\n});",
  );
});

// Flat test files are the common shape in this repo, so a test with no describe above it must not
// have to invent one.
test("suites may be absent or empty", () => {
  for (const suites of [undefined, []]) {
    const parsed = parseTestMapDocument(
      doc({
        files: [{ path: "a.test.ts", tests: [oneTest({ suites })] }],
      }),
    );
    expect(parsed.files[0].tests[0].suites).toEqual([]);
  }
});

test("a target carries the implementation's path and excerpt", () => {
  const parsed = parseTestMapDocument(
    doc({
      files: [
        {
          path: "a.test.ts",
          tests: [
            oneTest({
              target: { path: " core/a.ts ", code: "export function a() {}" },
            }),
          ],
        },
      ],
    }),
  );
  expect(parsed.files[0].tests[0].target).toEqual({
    path: "core/a.ts",
    code: "export function a() {}",
  });
});

test("a malformed document is rejected, naming what is wrong", () => {
  const cases: [unknown, string][] = [
    [doc({ version: 2 }), "document.version"],
    [doc({ summary: "  " }), "document.summary"],
    [doc({ files: [] }), "document.files"],
    [doc({ files: [{ path: "a.test.ts", tests: [] }] }), "tests"],
    [
      doc({ files: [{ path: "a.test.ts", tests: [oneTest({ code: "  " })] }] }),
      "code",
    ],
    [
      doc({
        files: [{ path: "a.test.ts", tests: [oneTest({ title: 7 })] }],
      }),
      "title",
    ],
    [
      doc({
        files: [
          {
            path: "a.test.ts",
            tests: [oneTest({ target: { path: "core/a.ts" } })],
          },
        ],
      }),
      "target.code",
    ],
  ];
  for (const [value, where] of cases) {
    expect(() => parseTestMapDocument(value)).toThrow(TestMapDocumentError);
    expect(() => parseTestMapDocument(value)).toThrow(where);
  }
});

test("text that is not JSON is rejected as such", () => {
  expect(() => parseTestMapDocumentText("{")).toThrow(TestMapDocumentError);
  expect(parseTestMapDocumentText(JSON.stringify(doc())).summary).toBe(
    "Covers the document parser",
  );
});

test("the document's paths and test count are read off it", () => {
  const parsed = parseTestMapDocument(
    doc({
      files: [
        { path: "a.test.ts", tests: [oneTest(), oneTest()] },
        { path: "b.test.ts", tests: [oneTest()] },
      ],
    }),
  );
  expect([...testMapDocumentPaths(parsed)]).toEqual(["a.test.ts", "b.test.ts"]);
  expect(testMapTestCount(parsed)).toBe(3);
});

// The Not covered listing is only as good as this, and it is deliberately a heuristic: being wrong
// costs one row in a list a human is reading.
test("test files are recognized across the usual naming conventions", () => {
  for (const path of [
    "core/store.test.ts",
    "web/src/components/pull-detail.test.tsx",
    "app/models/user_spec.rb",
    "pkg/thing_test.go",
    "tests/integration/boot.py",
    "web/src/__tests__/helper.ts",
    "python/test_parser.py",
  ]) {
    expect(isTestFilePath(path)).toBe(true);
  }
  for (const path of [
    "core/store.ts",
    "docs/testing.md",
    "web/src/components/latest.tsx",
    "core/contest.ts",
  ]) {
    expect(isTestFilePath(path)).toBe(false);
  }
});

// Markdown is generated from the document, never stored, so what a paste reads as is settled here.
test("Markdown renders the tree as headings with the excerpts under them", () => {
  const markdown = testMapMarkdown(
    parseTestMapDocument(
      doc({
        summary: "Covers the parser",
        files: [
          {
            path: "core/a.test.ts",
            tests: [
              oneTest({
                suites: ["parse", "when empty"],
                title: "rejects it",
                summary: "An empty document is refused.",
                code: "expect(fn).toThrow();",
                target: { path: "core/a.ts", code: "export function a() {}" },
              }),
            ],
          },
        ],
      }),
    ),
  );
  expect(markdown).toContain("# Test map");
  expect(markdown).toContain("Covers the parser");
  expect(markdown).toContain("## core/a.test.ts");
  expect(markdown).toContain("### parse › when empty");
  expect(markdown).toContain("#### rejects it");
  expect(markdown).toContain("An empty document is refused.");
  expect(markdown).toContain("```ts\nexpect(fn).toThrow();\n```");
  expect(markdown).toContain("Implementation — `core/a.ts`");
});

// An excerpt may itself contain a fence — a prompt test asserting on Markdown, say — and a
// three-backtick fence around it would end the block in the middle of the code.
test("Markdown fences are longer than any backtick run inside the excerpt", () => {
  const withFence = ["const schema = `", "```json", "{}", "```", "`;"].join(
    "\n",
  );
  const markdown = testMapMarkdown(
    parseTestMapDocument(
      doc({
        files: [{ path: "a.test.ts", tests: [oneTest({ code: withFence })] }],
      }),
    ),
  );
  expect(markdown).toContain("````ts\n");
  expect(markdown.trimEnd().endsWith("````")).toBe(true);
});
