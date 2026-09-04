import type { DiffFeedbackThread, PullDiff } from "@/api/types";
import type { PositionedDiffLine } from "@/lib/diff";

type DiffSide = DiffFeedbackThread["anchor"]["side"];

export type DiffThreadPlacement = {
  thread: DiffFeedbackThread;
  anchor: {
    side: DiffSide;
    startLine: number;
    endLine: number;
  };
};

export interface DiffSelection {
  side: DiffSide;
  startLine: number;
  endLine: number;
  hunk: number;
}

export interface SelectableDiffLine {
  side: DiffSide;
  line: number;
  hunk: number;
}

export type SelectableLines = Map<string, SelectableDiffLine>;

// Keyed by side and line number, not by position in the array: the diff a view renders and the
// diff that says which lines can be commented on are fetched separately, so their arrays line up
// only by luck. A line number means the same thing in both.
export function selectableLines(
  lines: PullDiff["files"][number]["lines"],
): SelectableLines {
  const result: SelectableLines = new Map();
  let hunk = -1;
  lines.forEach((line) => {
    if (line.kind === "hunk") hunk += 1;
    if (line.left_line != null)
      result.set(selectableKey("LEFT", line.left_line), {
        side: "LEFT",
        line: line.left_line,
        hunk,
      });
    if (line.right_line != null)
      result.set(selectableKey("RIGHT", line.right_line), {
        side: "RIGHT",
        line: line.right_line,
        hunk,
      });
  });
  return result;
}

function selectableKey(side: DiffSide, line: number) {
  return `${side}:${line}`;
}

// The rendered line, or undefined when this side of the line cannot take a comment — including a
// line the commentable diff does not describe at all.
export function selectableAt(
  selectable: SelectableLines,
  side: DiffSide,
  line: number | null,
) {
  return line == null ? undefined : selectable.get(selectableKey(side, line));
}

export function singleSelection(line: SelectableDiffLine): DiffSelection {
  return {
    side: line.side,
    startLine: line.line,
    endLine: line.line,
    hunk: line.hunk,
  };
}

// A drag only produces a range inside one side and one hunk: an anchor stored on the server has
// to cover a contiguous run of lines, and crossing sides would mix LEFT and RIGHT coordinates.
export function dragSelection(
  anchor: SelectableDiffLine,
  current: SelectableDiffLine,
): DiffSelection | null {
  if (current.side !== anchor.side || current.hunk !== anchor.hunk) return null;
  return {
    side: anchor.side,
    startLine: Math.min(anchor.line, current.line),
    endLine: Math.max(anchor.line, current.line),
    hunk: anchor.hunk,
  };
}

export function selectionContains(
  selection: DiffSelection | null,
  side: DiffSide,
  line: number | null,
) {
  return (
    line != null &&
    selection?.side === side &&
    line >= selection.startLine &&
    line <= selection.endLine
  );
}

function lineNumber(line: PositionedDiffLine, side: DiffSide) {
  return side === "LEFT" ? line.oldLine : line.newLine;
}

/** Find a current diff line near a historical anchor by matching retained context. */
export function historicalDiffFeedbackPlacement(
  lines: PositionedDiffLine[],
  thread: DiffFeedbackThread,
): DiffThreadPlacement | null {
  const context = thread.original_context?.filter((line) => {
    const number =
      thread.anchor.side === "LEFT" ? line.left_line : line.right_line;
    return number != null && line.kind !== "hunk" && line.kind !== "meta";
  });
  if (!context || context.length === 0) return null;

  const candidates = context.flatMap((contextLine) => {
    const originalLine =
      thread.anchor.side === "LEFT"
        ? contextLine.left_line
        : contextLine.right_line;
    if (originalLine == null) return [];
    return lines.flatMap((currentLine) => {
      const currentLineNumber = lineNumber(currentLine, thread.anchor.side);
      if (currentLineNumber == null || currentLine.text !== contextLine.text) {
        return [];
      }
      return [{ currentLineNumber, originalLine }];
    });
  });
  if (candidates.length === 0) return null;

  const match = candidates.reduce((best, candidate) => {
    const candidateDistance = Math.abs(
      candidate.originalLine - thread.anchor.end_line,
    );
    const bestDistance = Math.abs(best.originalLine - thread.anchor.end_line);
    if (candidateDistance !== bestDistance) {
      return candidateDistance < bestDistance ? candidate : best;
    }
    return Math.abs(candidate.currentLineNumber - candidate.originalLine) <
      Math.abs(best.currentLineNumber - best.originalLine)
      ? candidate
      : best;
  });
  const desiredEnd =
    match.currentLineNumber + thread.anchor.end_line - match.originalLine;
  const currentLines = lines
    .map((line) => lineNumber(line, thread.anchor.side))
    .filter((line): line is number => line != null);
  if (currentLines.length === 0) return null;
  const displayEnd = currentLines.reduce((best, line) => {
    const distance = Math.abs(line - desiredEnd);
    const bestDistance = Math.abs(best - desiredEnd);
    return distance < bestDistance ||
      (distance === bestDistance && line >= desiredEnd)
      ? line
      : best;
  });

  return {
    thread,
    anchor: {
      side: thread.anchor.side,
      startLine: displayEnd,
      endLine: displayEnd,
    },
  };
}
