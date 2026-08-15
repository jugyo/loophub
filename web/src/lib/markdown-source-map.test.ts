import { describe, expect, it } from "vitest";
import {
  markdownDiffAnnotations,
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

  it("derives side-specific changes and contiguous commentable ranges", () => {
    const blocks = [
      markdownRenderedBlock("paragraph", {
        position: {
          start: { line: 2, column: 1 },
          end: { line: 5, column: 1 },
        },
      }),
    ];
    const annotations = markdownDiffAnnotations(blocks, [
      { kind: "hunk", text: "", left_line: null, right_line: null },
      { kind: "context", text: "", left_line: 2, right_line: 2 },
      { kind: "deletion", text: "", left_line: 3, right_line: null },
      { kind: "addition", text: "", left_line: null, right_line: 3 },
      { kind: "context", text: "", left_line: 4, right_line: 4 },
      { kind: "hunk", text: "", left_line: null, right_line: null },
      { kind: "addition", text: "", left_line: null, right_line: 5 },
    ]);

    expect(annotations).toEqual([
      {
        block: blocks[0],
        changeKind: { LEFT: "removed", RIGHT: "added" },
        commentableRanges: [
          { side: "LEFT", hunk: 0, startLine: 2, endLine: 4 },
          { side: "RIGHT", hunk: 0, startLine: 2, endLine: 4 },
          { side: "RIGHT", hunk: 1, startLine: 5, endLine: 5 },
        ],
      },
    ]);
  });

  it("assigns overlapping lines to the smallest nested block", () => {
    const parent = markdownRenderedBlock("blockquote", {
      position: {
        start: { line: 1, column: 1 },
        end: { line: 3, column: 1 },
      },
    });
    const child = markdownRenderedBlock("paragraph", {
      position: {
        start: { line: 2, column: 1 },
        end: { line: 2, column: 1 },
      },
    });

    expect(
      markdownDiffAnnotations(
        [parent, child],
        [
          { kind: "hunk", text: "", left_line: null, right_line: null },
          { kind: "context", text: "", left_line: 1, right_line: 1 },
          { kind: "addition", text: "", left_line: null, right_line: 2 },
          { kind: "context", text: "", left_line: 3, right_line: 3 },
        ],
      ),
    ).toEqual([
      {
        block: parent,
        changeKind: { LEFT: "context", RIGHT: "context" },
        commentableRanges: [
          { side: "LEFT", hunk: 0, startLine: 1, endLine: 1 },
          { side: "LEFT", hunk: 0, startLine: 3, endLine: 3 },
          { side: "RIGHT", hunk: 0, startLine: 1, endLine: 1 },
          { side: "RIGHT", hunk: 0, startLine: 3, endLine: 3 },
        ],
      },
      {
        block: child,
        changeKind: { LEFT: null, RIGHT: "added" },
        commentableRanges: [
          { side: "RIGHT", hunk: 0, startLine: 2, endLine: 2 },
        ],
      },
    ]);
  });

  it("ignores lines outside source ranges, patch hunks, and blocks without positions", () => {
    const block = markdownRenderedBlock("paragraph", undefined);
    expect(
      markdownDiffAnnotations(
        [block],
        [{ kind: "addition", text: "", left_line: null, right_line: 1 }],
      ),
    ).toEqual([]);
  });
});
