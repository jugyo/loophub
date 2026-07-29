import { describe, expect, it } from "vitest";
import {
  extendSelection,
  selectableLines,
  selectionContains,
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
    expect(lines.get(1)).toEqual([
      { side: "LEFT", line: 1, hunk: 0 },
      { side: "RIGHT", line: 1, hunk: 0 },
    ]);
    expect(lines.get(2)).toEqual([{ side: "LEFT", line: 2, hunk: 0 }]);
  });

  it("extends only contiguous coordinates on the same side and hunk", () => {
    const first = extendSelection(null, { side: "LEFT", line: 4, hunk: 0 });
    expect(
      extendSelection(first, { side: "LEFT", line: 5, hunk: 0 }),
    ).toMatchObject({ startLine: 4, endLine: 5 });
    expect(
      extendSelection(first, { side: "RIGHT", line: 5, hunk: 0 }),
    ).toMatchObject({ side: "RIGHT", startLine: 5, endLine: 5 });
    expect(
      extendSelection(first, { side: "LEFT", line: 5, hunk: 1 }),
    ).toMatchObject({ startLine: 5, endLine: 5, hunk: 1 });
    expect(
      extendSelection(first, { side: "LEFT", line: 7, hunk: 0 }),
    ).toMatchObject({ startLine: 7, endLine: 7 });
    expect(selectionContains(first, "LEFT", 4)).toBe(true);
  });
});
