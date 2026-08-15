import { describe, expect, it } from "vitest";
import {
  markdownRenderedBlock,
  markdownSourceRange,
} from "./markdown-source-map";

describe("markdown source mapping", () => {
  it("converts a positioned node to an inclusive line range", () => {
    expect(
      markdownSourceRange({
        position: {
          start: { line: 3, column: 1, offset: 10 },
          end: { line: 5, column: 4, offset: 30 },
        },
      }),
    ).toEqual({ startLine: 3, endLine: 5 });
  });

  it("represents generated elements without a source position explicitly", () => {
    expect(markdownRenderedBlock("paragraph", undefined)).toEqual({
      kind: "paragraph",
      sourceRange: null,
    });
  });

  it("rejects invalid positions", () => {
    expect(
      markdownSourceRange({
        position: {
          start: { line: 4, column: 1 },
          end: { line: 2, column: 1 },
        },
      }),
    ).toBeNull();
  });
});
