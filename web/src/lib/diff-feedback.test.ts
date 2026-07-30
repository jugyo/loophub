import { describe, expect, it } from "vitest";
import {
  dragSelection,
  selectableAt,
  selectableLines,
  selectionContains,
  singleSelection,
} from "./diff-feedback";

describe("diff feedback selection", () => {
  it("exposes both sides for context and only the existing side for changes", () => {
    const lines = selectableLines([
      {
        kind: "hunk",
        text: "@@ -1,2 +1,2 @@",
        left_line: null,
        right_line: null,
      },
      {
        kind: "context",
        text: " same",
        left_line: 1,
        right_line: 1,
      },
      {
        kind: "deletion",
        text: "-old",
        left_line: 2,
        right_line: null,
      },
    ]);
    expect(selectableAt(lines, "LEFT", 1)).toEqual({
      side: "LEFT",
      line: 1,
      hunk: 0,
    });
    expect(selectableAt(lines, "RIGHT", 1)).toEqual({
      side: "RIGHT",
      line: 1,
      hunk: 0,
    });
    expect(selectableAt(lines, "LEFT", 2)).toEqual({
      side: "LEFT",
      line: 2,
      hunk: 0,
    });
    // The deletion has no right-hand line, and nothing describes right-hand line 2 at all.
    expect(selectableAt(lines, "RIGHT", 2)).toBeUndefined();
    expect(selectableAt(lines, "LEFT", null)).toBeUndefined();
  });

  it("finds a line by its number however the diff array is ordered or offset", () => {
    // The view renders one diff and asks this map about another, so positions cannot be assumed.
    const lines = selectableLines([
      {
        kind: "hunk",
        text: "@@ -40,2 +40,2 @@",
        left_line: null,
        right_line: null,
      },
      { kind: "deletion", text: "-old", left_line: 40, right_line: null },
      { kind: "addition", text: "+new", left_line: null, right_line: 40 },
      {
        kind: "hunk",
        text: "@@ -90 +90 @@",
        left_line: null,
        right_line: null,
      },
      { kind: "context", text: " tail", left_line: 90, right_line: 90 },
    ]);

    expect(selectableAt(lines, "RIGHT", 40)).toEqual({
      side: "RIGHT",
      line: 40,
      hunk: 0,
    });
    expect(selectableAt(lines, "LEFT", 90)).toEqual({
      side: "LEFT",
      line: 90,
      hunk: 1,
    });
    expect(selectableAt(lines, "RIGHT", 41)).toBeUndefined();
  });

  it("selects a single line", () => {
    const single = singleSelection({ side: "LEFT", line: 4, hunk: 0 });
    expect(single).toEqual({
      side: "LEFT",
      startLine: 4,
      endLine: 4,
      hunk: 0,
    });
    expect(selectionContains(single, "LEFT", 4)).toBe(true);
  });

  it("drags a range in either direction within one side and hunk", () => {
    const anchor = { side: "LEFT" as const, line: 4, hunk: 0 };
    expect(dragSelection(anchor, { side: "LEFT", line: 6, hunk: 0 })).toEqual({
      side: "LEFT",
      startLine: 4,
      endLine: 6,
      hunk: 0,
    });
    expect(dragSelection(anchor, { side: "LEFT", line: 2, hunk: 0 })).toEqual({
      side: "LEFT",
      startLine: 2,
      endLine: 4,
      hunk: 0,
    });
    expect(
      dragSelection(anchor, { side: "RIGHT", line: 5, hunk: 0 }),
    ).toBeNull();
    expect(
      dragSelection(anchor, { side: "LEFT", line: 5, hunk: 1 }),
    ).toBeNull();
  });
});
