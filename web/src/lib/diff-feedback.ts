import type { DiffFeedbackThread, PullDiff } from "@/api/types";

type DiffSide = DiffFeedbackThread["anchor"]["side"];

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

export function selectableLines(
  lines: PullDiff["files"][number]["lines"],
): Map<number, SelectableDiffLine[]> {
  const result = new Map<number, SelectableDiffLine[]>();
  let hunk = -1;
  lines.forEach((line, index) => {
    if (line.kind === "hunk") hunk += 1;
    const candidates: SelectableDiffLine[] = [];
    if (line.left_line != null)
      candidates.push({ side: "LEFT", line: line.left_line, hunk });
    if (line.right_line != null)
      candidates.push({ side: "RIGHT", line: line.right_line, hunk });
    result.set(index, candidates);
  });
  return result;
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
