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

export function extendSelection(
  current: DiffSelection | null,
  next: SelectableDiffLine,
): DiffSelection {
  if (
    current &&
    current.side === next.side &&
    current.hunk === next.hunk &&
    (next.line === current.startLine - 1 || next.line === current.endLine + 1)
  ) {
    return {
      ...current,
      startLine: Math.min(current.startLine, next.line),
      endLine: Math.max(current.endLine, next.line),
    };
  }
  return {
    side: next.side,
    startLine: next.line,
    endLine: next.line,
    hunk: next.hunk,
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
