import { expect, test } from "vitest";
import {
  CHANGE_MAP_MAX_CATEGORIES,
  ChangeMapDocumentError,
  changeMapDocumentPaths,
  parseChangeMapDocument,
  parseChangeMapDocumentText,
} from "./change-map-document.ts";

const change = (files: string[]) => ({
  name: "Change map rows",
  kind: "store",
  summary: "Insert one, read the newest",
  files,
});

const doc = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  summary: "Stored the map",
  categories: [
    {
      name: "Storing the map",
      summary: "Where it lands",
      changes: [change(["a.ts"])],
    },
  ],
  ...overrides,
});

test("a well-formed document parses, trimmed", () => {
  const parsed = parseChangeMapDocument(doc({ summary: "  Stored the map  " }));
  expect(parsed.summary).toBe("Stored the map");
  expect(parsed.categories[0].changes[0].files).toEqual([{ path: "a.ts" }]);
});

// A bare path is the common case; an object carries a note about that one file. Both are accepted
// so a document does not pay object syntax for every file to say nothing about most of them.
test("a file entry may be a bare path or an object with a summary", () => {
  const parsed = parseChangeMapDocument(
    doc({
      categories: [
        {
          name: "c",
          summary: "s",
          changes: [
            {
              ...change([]),
              files: [
                "a.ts",
                { path: " b.ts " },
                { path: "c.ts", summary: "  Rewired the entry point.  " },
                { path: "d.ts", summary: "  " },
              ],
            },
          ],
        },
      ],
    }),
  );
  expect(parsed.categories[0].changes[0].files).toEqual([
    { path: "a.ts" },
    { path: "b.ts" },
    { path: "c.ts", summary: "Rewired the entry point." },
    { path: "d.ts" },
  ]);
});

test("a file object without a usable path is rejected", () => {
  const withFiles = (files: unknown[]) =>
    doc({
      categories: [
        { name: "c", summary: "s", changes: [{ ...change([]), files }] },
      ],
    });
  expect(() => parseChangeMapDocument(withFiles([{ summary: "x" }]))).toThrow(
    /files\[0\]\.path/,
  );
  expect(() => parseChangeMapDocument(withFiles([{ path: "  " }]))).toThrow(
    /files\[0\]\.path/,
  );
  expect(() => parseChangeMapDocument(withFiles([3]))).toThrow(/files\[0\]/);
});

test("optional notes are kept when present and dropped when blank", () => {
  const withNotes = parseChangeMapDocument(
    doc({
      categories: [
        {
          name: "c",
          summary: "s",
          changes: [{ ...change(["a.ts"]), tests: " covered ", risk: "" }],
        },
      ],
    }),
  );
  expect(withNotes.categories[0].changes[0].tests).toBe("covered");
  expect(withNotes.categories[0].changes[0].risk).toBeUndefined();
});

test("the version must be the one this build writes", () => {
  expect(() => parseChangeMapDocument(doc({ version: 2 }))).toThrow(
    ChangeMapDocumentError,
  );
  expect(() => parseChangeMapDocument(doc({ version: undefined }))).toThrow(
    /document.version/,
  );
});

test("every level must be present and non-empty", () => {
  expect(() => parseChangeMapDocument(doc({ summary: "   " }))).toThrow(
    /document.summary/,
  );
  expect(() => parseChangeMapDocument(doc({ categories: [] }))).toThrow(
    /document.categories/,
  );
  expect(() =>
    parseChangeMapDocument(
      doc({ categories: [{ name: "c", summary: "s", changes: [] }] }),
    ),
  ).toThrow(/changes/);
  expect(() =>
    parseChangeMapDocument(
      doc({ categories: [{ name: "c", summary: "s", changes: [change([])] }] }),
    ),
  ).toThrow(/files/);
});

// The cap is what forces the grouping work; without it a map reproduces the directory tree.
test("categories are capped, and the cap itself is allowed", () => {
  const category = (i: number) => ({
    name: `c${i}`,
    summary: "s",
    changes: [change(["a.ts"])],
  });
  const upTo = (n: number) =>
    doc({
      categories: Array.from({ length: n }, (_, i) => category(i)),
    });
  expect(
    parseChangeMapDocument(upTo(CHANGE_MAP_MAX_CATEGORIES)).categories,
  ).toHaveLength(CHANGE_MAP_MAX_CATEGORIES);
  expect(() =>
    parseChangeMapDocument(upTo(CHANGE_MAP_MAX_CATEGORIES + 1)),
  ).toThrow(/at most/);
});

test("non-objects are rejected rather than coerced", () => {
  for (const value of [null, [], "x", 3]) {
    expect(() => parseChangeMapDocument(value)).toThrow(ChangeMapDocumentError);
  }
});

test("text parsing reports invalid JSON as a document error", () => {
  expect(() => parseChangeMapDocumentText("{oops")).toThrow(
    ChangeMapDocumentError,
  );
  expect(parseChangeMapDocumentText(JSON.stringify(doc())).summary).toBe(
    "Stored the map",
  );
});

test("declared paths are collected across the whole document, deduplicated", () => {
  const parsed = parseChangeMapDocument(
    doc({
      categories: [
        { name: "c1", summary: "s", changes: [change(["a.ts", "b.ts"])] },
        { name: "c2", summary: "s", changes: [change(["b.ts", "c.ts"])] },
      ],
    }),
  );
  expect([...changeMapDocumentPaths(parsed)]).toEqual(["a.ts", "b.ts", "c.ts"]);
});
