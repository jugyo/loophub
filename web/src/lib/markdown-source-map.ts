import type { Position } from "unist";

/** A 1-based, inclusive range in the Markdown source. */
export type MarkdownSourceRange = {
  startLine: number;
  endLine: number;
};

/** Rendered block kinds that can later be used as comment anchors. */
export type MarkdownRenderedBlockKind =
  | "paragraph"
  | "heading"
  | "list-item"
  | "blockquote"
  | "code-block"
  | "table-row"
  | "image"
  | "mermaid";

/** Client-only metadata connecting one rendered block to its Markdown source. */
export type MarkdownRenderedBlock = {
  kind: MarkdownRenderedBlockKind;
  sourceRange: MarkdownSourceRange | null;
};

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
