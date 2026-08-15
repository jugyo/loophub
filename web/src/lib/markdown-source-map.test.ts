import { describe, expect, it } from "vitest";
import type { DiffFeedbackThreadWire } from "../../../core/serialize";
import {
  markdownDiffAnnotations,
  markdownDiffFeedbackPlacements,
  markdownRenderedBlock,
  markdownSourceRange,
} from "./markdown-source-map";

function thread(
  patch: Partial<DiffFeedbackThreadWire> = {},
): DiffFeedbackThreadWire {
  return {
    id: 1,
    pr_number: 10,
    anchor: {
      base_sha: "base",
      head_sha: "head",
      path: "README.md",
      original_path: null,
      side: "RIGHT",
      start_line: 2,
      end_line: 2,
    },
    resolved_anchor: null,
    freshness: "current",
    outdated_reason: null,
    placement: "inline",
    original_context: null,
    archived_at: null,
    created_by: "me",
    created_by_type: "human",
    created_at: "2026-01-01T00:00:00.000Z",
    messages: [],
    ...patch,
  };
}

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

  it("prefers a resolved anchor and places a current thread in the smallest block", () => {
    const parent = markdownRenderedBlock("blockquote", {
      position: {
        start: { line: 1, column: 1 },
        end: { line: 5, column: 1 },
      },
    });
    const child = markdownRenderedBlock("paragraph", {
      position: {
        start: { line: 3, column: 1 },
        end: { line: 4, column: 1 },
      },
    });

    expect(
      markdownDiffFeedbackPlacements(
        [parent, child],
        [
          thread({
            anchor: { ...thread().anchor, start_line: 1, end_line: 1 },
            resolved_anchor: {
              path: "README.md",
              original_path: null,
              side: "LEFT",
              start_line: 3,
              end_line: 4,
            },
          }),
        ],
      ),
    ).toEqual([
      {
        thread: expect.anything(),
        anchor: { side: "LEFT", startLine: 3, endLine: 4 },
        placement: "rendered",
        block: child,
      },
    ]);
  });

  it("assigns a range crossing blocks once using the block containing end_line", () => {
    const first = markdownRenderedBlock("paragraph", {
      position: {
        start: { line: 2, column: 1 },
        end: { line: 3, column: 1 },
      },
    });
    const second = markdownRenderedBlock("paragraph", {
      position: {
        start: { line: 4, column: 1 },
        end: { line: 6, column: 1 },
      },
    });
    const result = markdownDiffFeedbackPlacements(
      [first, second],
      [thread({ anchor: { ...thread().anchor, start_line: 3, end_line: 5 } })],
    );

    expect(result).toHaveLength(1);
    expect(result[0].block).toBe(second);
    expect(result[0].placement).toBe("rendered");
  });

  it("keeps historical and unavailable threads source-only and preserves order", () => {
    const block = markdownRenderedBlock("paragraph", {
      position: {
        start: { line: 2, column: 1 },
        end: { line: 4, column: 1 },
      },
    });
    const historical = thread({
      id: 2,
      freshness: "outdated",
      placement: "historical",
      resolved_anchor: {
        path: "README.md",
        original_path: null,
        side: "RIGHT",
        start_line: 2,
        end_line: 2,
      },
    });
    const unavailable = thread({
      id: 3,
      freshness: "unavailable",
      placement: "historical",
      resolved_anchor: null,
      anchor: { ...thread().anchor, start_line: 3, end_line: 3 },
    });

    expect(
      markdownDiffFeedbackPlacements([block], [historical, unavailable]),
    ).toEqual([
      {
        thread: historical,
        anchor: { side: "RIGHT", startLine: 2, endLine: 2 },
        placement: "source-only",
        block: null,
      },
      {
        thread: unavailable,
        anchor: { side: "RIGHT", startLine: 3, endLine: 3 },
        placement: "source-only",
        block: null,
      },
    ]);
  });
});
