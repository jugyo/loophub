import { describe, expect, it } from "vitest";
import {
  dragSelection,
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
    expect(lines.get(1)).toEqual([
      { side: "LEFT", line: 1, hunk: 0 },
      { side: "RIGHT", line: 1, hunk: 0 },
    ]);
    expect(lines.get(2)).toEqual([{ side: "LEFT", line: 2, hunk: 0 }]);
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
