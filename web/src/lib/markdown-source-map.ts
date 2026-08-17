import type { Position } from "unist";
import type {
  DiffFeedbackThreadWire,
  PullDiffWire,
} from "../../../core/serialize";

/** A 1-based, inclusive range in the Markdown source. */
export type MarkdownSourceRange = {
  startLine: number;
  endLine: number;
};

/** Rendered block kinds that can later be used as comment anchors. */
export type MarkdownRenderedBlockKind =
  | "paragraph"
  | "heading"
  | "list"
  | "list-item"
  | "blockquote"
  | "code-block"
  | "table"
  | "table-row"
  | "image"
  | "mermaid";

/** Client-only metadata connecting one rendered block to its Markdown source. */
export type MarkdownRenderedBlock = {
  kind: MarkdownRenderedBlockKind;
  sourceRange: MarkdownSourceRange | null;
};

export type MarkdownDiffSide = "LEFT" | "RIGHT";
export type MarkdownDiffChangeKind = "added" | "removed" | "context";

export type MarkdownCommentableRange = {
  side: MarkdownDiffSide;
  hunk: number;
  startLine: number;
  endLine: number;
};

export type MarkdownDiffAnnotation = {
  block: MarkdownRenderedBlock;
  changeKind: Record<MarkdownDiffSide, MarkdownDiffChangeKind | null>;
  commentableRanges: MarkdownCommentableRange[];
};

export type MarkdownDiffFeedbackThreadPlacement = {
  thread: DiffFeedbackThreadWire;
  anchor: {
    side: MarkdownDiffSide;
    startLine: number;
    endLine: number;
  };
  placement: "rendered" | "source-only";
  block: MarkdownRenderedBlock | null;
};

type DiffLine = PullDiffWire["files"][number]["lines"][number];

type PositionedNode = {
  position?: Position;
};

/** Convert a react-markdown node position into the line range used by the client. */
export function markdownSourceRange(
  node: PositionedNode | null | undefined,
): MarkdownSourceRange | null {
  const position = node?.position;
  if (!position) return null;

  const { start, end } = position;
  if (
    !Number.isInteger(start.line) ||
    !Number.isInteger(end.line) ||
    start.line < 1 ||
    end.line < start.line
  ) {
    return null;
  }
  return { startLine: start.line, endLine: end.line };
}

/** Create metadata for a rendered block, including generated blocks without a position. */
export function markdownRenderedBlock(
  kind: MarkdownRenderedBlockKind,
  node: PositionedNode | null | undefined,
): MarkdownRenderedBlock {
  return { kind, sourceRange: markdownSourceRange(node) };
}

/**
 * Derive diff annotations for rendered blocks from source line ranges and one file's diff lines.
 * Each diff line is assigned to the smallest block containing its source line, which prevents
 * parent/child Markdown blocks from producing duplicate comment targets.
 */
export function markdownDiffAnnotations(
  blocks: MarkdownRenderedBlock[],
  lines: DiffLine[],
): MarkdownDiffAnnotation[] {
  const assigned = new Map<number, Map<string, DiffLine[]>>();
  let hunk = -1;

  for (const line of lines) {
    if (line.kind === "hunk") hunk += 1;
    if (line.kind === "meta" || line.kind === "hunk") continue;

    for (const side of ["LEFT", "RIGHT"] as const) {
      const sourceLine = side === "LEFT" ? line.left_line : line.right_line;
      if (sourceLine == null) continue;
      const candidates = blocks
        .map((block, index) => ({ block, index }))
        .filter(({ block }) => {
          const range = block.sourceRange;
          return (
            range != null &&
            sourceLine >= range.startLine &&
            sourceLine <= range.endLine
          );
        });
      if (candidates.length === 0) continue;

      const selected = candidates.reduce((best, candidate) => {
        const bestRange = best.block.sourceRange!;
        const candidateRange = candidate.block.sourceRange!;
        const bestSize = bestRange.endLine - bestRange.startLine;
        const candidateSize = candidateRange.endLine - candidateRange.startLine;
        return candidateSize <= bestSize ? candidate : best;
      });
      const key = `${side}:${hunk}`;
      const byRange =
        assigned.get(selected.index) ?? new Map<string, DiffLine[]>();
      const rangeLines = byRange.get(key) ?? [];
      rangeLines.push({
        ...line,
        ...(side === "LEFT"
          ? { left_line: sourceLine }
          : { right_line: sourceLine }),
      });
      byRange.set(key, rangeLines);
      assigned.set(selected.index, byRange);
    }
  }

  return [...assigned.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, byRange]) => {
      const ranges = [...byRange.entries()].flatMap(([key, rangeLines]) => {
        const [side, hunkText] = key.split(":");
        const lineNumbers = rangeLines
          .map((line) => (side === "LEFT" ? line.left_line : line.right_line))
          .filter((line): line is number => line != null)
          .sort((a, b) => a - b);
        const result: MarkdownCommentableRange[] = [];
        for (const line of lineNumbers) {
          const previous = result.at(-1);
          if (previous && previous.endLine + 1 === line) {
            previous.endLine = line;
          } else {
            result.push({
              side: side as MarkdownDiffSide,
              hunk: Number(hunkText),
              startLine: line,
              endLine: line,
            });
          }
        }
        return result;
      });
      const changeKind = { LEFT: null, RIGHT: null } as Record<
        MarkdownDiffSide,
        MarkdownDiffChangeKind | null
      >;
      for (const [key, rangeLines] of byRange) {
        const side = key.startsWith("LEFT:") ? "LEFT" : "RIGHT";
        const kinds = new Set(
          rangeLines.map((line) => changeKindFor(side, line.kind)),
        );
        changeKind[side] = kinds.has("added")
          ? "added"
          : kinds.has("removed")
            ? "removed"
            : "context";
      }
      return { block: blocks[index], changeKind, commentableRanges: ranges };
    });
}

/**
 * Place diff feedback threads in a rendered Markdown preview without changing their order.
 * Resolved coordinates are preferred because they describe the current patch; the original
 * anchor is retained for historical or unavailable threads so callers can still show a source
 * location. A thread is attached to one smallest block containing its end line, which also makes
 * a range crossing multiple blocks appear only once.
 */
export function markdownDiffFeedbackPlacements(
  blocks: MarkdownRenderedBlock[],
  threads: DiffFeedbackThreadWire[],
): MarkdownDiffFeedbackThreadPlacement[] {
  return threads.map((thread) => {
    const anchor = thread.resolved_anchor ?? thread.anchor;
    const placement = {
      side: anchor.side,
      startLine: anchor.start_line,
      endLine: anchor.end_line,
    } satisfies MarkdownDiffFeedbackThreadPlacement["anchor"];

    if (thread.placement !== "inline") {
      return {
        thread,
        anchor: placement,
        placement: "source-only",
        block: null,
      };
    }

    const block = blocks
      .filter((candidate) => {
        const range = candidate.sourceRange;
        return (
          range != null &&
          placement.endLine >= range.startLine &&
          placement.endLine <= range.endLine
        );
      })
      .reduce<MarkdownRenderedBlock | null>((smallest, candidate) => {
        if (!smallest) return candidate;
        const currentRange = candidate.sourceRange!;
        const smallestRange = smallest.sourceRange!;
        const currentSize = currentRange.endLine - currentRange.startLine;
        const smallestSize = smallestRange.endLine - smallestRange.startLine;
        return currentSize < smallestSize ? candidate : smallest;
      }, null);

    return {
      thread,
      anchor: placement,
      placement: block ? "rendered" : "source-only",
      block,
    };
  });
}

/**
 * Place one side's rendered block in a unified Markdown diff.
 *
 * LEFT contributes deleted blocks only. RIGHT contributes added blocks and the surrounding
 * context, preferring an addition's patch position when one block also contains context. A
 * context-only RIGHT block uses its last patch position so it does not precede a deletion within
 * the same multi-line block. The returned patch-line index lets both independently rendered
 * documents share one ordered column.
 */
export function markdownUnifiedBlockOrder(
  block: MarkdownRenderedBlock,
  lines: DiffLine[],
  side: MarkdownDiffSide,
): number | null {
  const range = block.sourceRange;
  if (!range) return null;

  const coordinate = side === "LEFT" ? "left_line" : "right_line";
  const preferredKind = side === "LEFT" ? "deletion" : "addition";
  let contextIndex: number | null = null;

  for (const [index, line] of lines.entries()) {
    const sourceLine = line[coordinate];
    if (
      sourceLine == null ||
      sourceLine < range.startLine ||
      sourceLine > range.endLine
    ) {
      continue;
    }
    if (line.kind === preferredKind) return index;
    if (side === "RIGHT" && line.kind === "context") {
      contextIndex = index;
    }
  }

  return contextIndex;
}

function changeKindFor(
  side: MarkdownDiffSide,
  kind: DiffLine["kind"],
): MarkdownDiffChangeKind {
  if (kind === "addition" && side === "RIGHT") return "added";
  if (kind === "deletion" && side === "LEFT") return "removed";
  return "context";
}
