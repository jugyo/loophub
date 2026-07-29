import { describe, expect, test } from "vitest";
import {
  linesAroundAnchor,
  linesForAnchor,
  parsePatchWithCoordinates,
} from "./diff-anchor.ts";

describe("parsePatchWithCoordinates", () => {
  const lines = parsePatchWithCoordinates(
    "@@ -2,3 +2,4 @@\n context\n-removed\n+added\n+another\n tail",
  );

  test("maps context, deletion, and addition lines to their sides", () => {
    expect(lines).toEqual([
      {
        kind: "hunk",
        text: "@@ -2,3 +2,4 @@",
        leftLine: null,
        rightLine: null,
      },
      { kind: "context", text: " context", leftLine: 2, rightLine: 2 },
      { kind: "deletion", text: "-removed", leftLine: 3, rightLine: null },
      { kind: "addition", text: "+added", leftLine: null, rightLine: 3 },
      { kind: "addition", text: "+another", leftLine: null, rightLine: 4 },
      { kind: "context", text: " tail", leftLine: 4, rightLine: 5 },
    ]);
  });

  test("resolves only complete, contiguous ranges on one side", () => {
    expect(
      linesForAnchor(lines, { side: "RIGHT", startLine: 3, endLine: 4 }),
    ).toHaveLength(2);
    expect(
      linesForAnchor(lines, { side: "LEFT", startLine: 3, endLine: 4 }),
    ).toHaveLength(2);
    expect(
      linesForAnchor(lines, { side: "RIGHT", startLine: 0, endLine: 1 }),
    ).toBeNull();
  });

  test("does not invent a context line from a trailing patch newline", () => {
    expect(parsePatchWithCoordinates("@@ -1 +1 @@\n-old\n+new\n")).toHaveLength(
      3,
    );
  });
});

describe("linesAroundAnchor", () => {
  const lines = parsePatchWithCoordinates(
    "@@ -2,3 +2,4 @@\n context\n-removed\n+added\n+another\n tail",
  );

  test("widens the anchored lines by the requested radius", () => {
    expect(
      linesAroundAnchor(lines, { side: "RIGHT", startLine: 3, endLine: 3 }, 1),
    ).toEqual(lines.slice(2, 5));
  });

  test("clamps the window to the patch it was read from", () => {
    expect(
      linesAroundAnchor(lines, { side: "RIGHT", startLine: 2, endLine: 2 }, 5),
    ).toEqual(lines);
  });

  test("reports an anchor that no longer resolves as unavailable", () => {
    expect(
      linesAroundAnchor(lines, { side: "RIGHT", startLine: 9, endLine: 9 }, 3),
    ).toBeNull();
  });
});
