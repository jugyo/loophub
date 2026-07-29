export type DiffSide = "LEFT" | "RIGHT";

export interface DiffAnchorRange {
  side: DiffSide;
  startLine: number;
  endLine: number;
}

export interface DiffLine {
  kind: "hunk" | "context" | "addition" | "deletion" | "meta";
  text: string;
  leftLine: number | null;
  rightLine: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse a unified patch into renderer-independent base/head coordinates. */
export function parsePatchWithCoordinates(patch: string): DiffLine[] {
  let left = 0;
  let right = 0;
  let inHunk = false;
  const sourceLines = patch.split("\n");
  if (sourceLines.at(-1) === "") sourceLines.pop();
  return sourceLines.map((text) => {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      left = Number(header[1]);
      right = Number(header[2]);
      inHunk = true;
      return { kind: "hunk", text, leftLine: null, rightLine: null };
    }
    if (!inHunk || text.startsWith("\\ No newline")) {
      return { kind: "meta", text, leftLine: null, rightLine: null };
    }
    if (text.startsWith("+")) {
      return {
        kind: "addition",
        text,
        leftLine: null,
        rightLine: right++,
      };
    }
    if (text.startsWith("-")) {
      return {
        kind: "deletion",
        text,
        leftLine: left++,
        rightLine: null,
      };
    }
    const line = {
      kind: "context" as const,
      text,
      leftLine: left++,
      rightLine: right++,
    };
    return line;
  });
}

/** Return the exact selectable lines for an anchor, or null when it is not on this patch. */
export function linesForAnchor(
  lines: DiffLine[],
  anchor: DiffAnchorRange,
): DiffLine[] | null {
  if (
    (anchor.side !== "LEFT" && anchor.side !== "RIGHT") ||
    !Number.isInteger(anchor.startLine) ||
    !Number.isInteger(anchor.endLine) ||
    anchor.startLine < 1 ||
    anchor.endLine < anchor.startLine
  ) {
    return null;
  }
  const key = anchor.side === "LEFT" ? "leftLine" : "rightLine";
  const selected = lines.filter((line) => {
    const n = line[key];
    return n != null && n >= anchor.startLine && n <= anchor.endLine;
  });
  if (selected.length !== anchor.endLine - anchor.startLine + 1) return null;
  return selected.every((line, index) => line[key] === anchor.startLine + index)
    ? selected
    : null;
}

/**
 * The anchored lines widened by `radius` neighbouring patch lines on each side, so a reader that
 * cannot see the diff itself still gets the code the anchor points at. Null when the anchor does
 * not resolve on this patch, which is the same "unavailable" fact `linesForAnchor` reports.
 */
export function linesAroundAnchor(
  lines: DiffLine[],
  anchor: DiffAnchorRange,
  radius: number,
): DiffLine[] | null {
  const anchored = linesForAnchor(lines, anchor);
  if (!anchored) return null;
  const first = lines.indexOf(anchored[0]);
  const last = lines.indexOf(anchored[anchored.length - 1]);
  return lines.slice(Math.max(0, first - radius), last + radius + 1);
}
