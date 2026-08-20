// Rendered Markdown diff, drawn one top-level block at a time.
//
// The diff decorates blocks with a comment gutter, a change highlight, inline threads, and the
// comment composer, all of which change while the reader works. Rendering the document as one
// <Markdown> meant every one of those changes re-parsed and re-converted the whole file (#356), so
// the source is parsed once (markdown-hast.ts) and each top-level block is converted to React on
// its own and memoized on its hast node. Only the block whose decoration changed re-renders.
//
// Decorations reach the elements through context rather than through the conversion, so the
// components map stays a module-level constant and the converted element tree can be reused.

import type { Element } from "hast";
import type { Components, Options } from "hast-util-to-jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import {
  Children,
  type CSSProperties,
  cloneElement,
  createContext,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useMemo,
} from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import {
  MarkdownImage,
  MarkdownLightboxProvider,
  MarkdownLink,
} from "@/components/markdown-elements";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import {
  type MarkdownHastBlockTree,
  markdownHast,
  markdownHastTopLevel,
  markdownMermaidChart,
} from "@/lib/markdown-hast";
import {
  type MarkdownRenderedBlock,
  type MarkdownRenderedBlockKind,
  markdownRenderedBlock,
  renderedBlockKey,
} from "@/lib/markdown-source-map";
import { cn } from "@/lib/utils";

/** How the diff decorates one block. Built by the pane; stable while the selection moves. */
export type MarkdownDiffBlockDecoration = {
  className?: string;
  style?: CSSProperties;
  /** Comment gutter, placed inside the block (or its wrapper, where a block cannot hold a span). */
  action?: ReactNode;
  /** Rendered after the block. `composer` is non-null only for the block holding the selection. */
  after?: (composer: ReactNode) => ReactNode;
};

export type MarkdownDiffDecorations = ReadonlyMap<
  string,
  MarkdownDiffBlockDecoration
>;

type ResolvedDecoration = {
  className?: string;
  style?: CSSProperties;
  action?: ReactNode;
  after?: ReactNode;
};

const DecorationContext = createContext<
  ReadonlyMap<string, ResolvedDecoration>
>(new Map());

function useDecoration(
  kind: MarkdownRenderedBlockKind,
  node: Element | undefined,
): ResolvedDecoration | undefined {
  const decorations = useContext(DecorationContext);
  return decorations.get(renderedBlockKey(markdownRenderedBlock(kind, node)));
}

type BlockProps = {
  node?: Element;
  children?: ReactNode;
  className?: string;
};

function blockComponent(
  tag: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "blockquote",
  kind: MarkdownRenderedBlockKind,
) {
  const Tag = tag;
  return function DiffBlock({ node, children, ...rest }: BlockProps) {
    const decoration = useDecoration(kind, node);
    return (
      <>
        <Tag
          {...rest}
          className={cn(rest.className, decoration?.className)}
          style={decoration?.style}
        >
          {decoration?.action}
          {children}
        </Tag>
        {decoration?.after}
      </>
    );
  };
}

// A list carries the change highlight and the unified ordering of its whole block, but its comment
// gutter belongs to the individual items.
function listComponent(tag: "ul" | "ol") {
  const Tag = tag;
  return function DiffList({ node, children, ...rest }: BlockProps) {
    const decoration = useDecoration("list", node);
    return (
      <>
        <Tag
          {...rest}
          className={cn(rest.className, decoration?.className)}
          style={decoration?.style}
        >
          {children}
        </Tag>
        {decoration?.after}
      </>
    );
  };
}

const COMPONENTS: Components = {
  p: blockComponent("p", "paragraph"),
  h1: blockComponent("h1", "heading"),
  h2: blockComponent("h2", "heading"),
  h3: blockComponent("h3", "heading"),
  h4: blockComponent("h4", "heading"),
  h5: blockComponent("h5", "heading"),
  h6: blockComponent("h6", "heading"),
  li: blockComponent("li", "list-item"),
  blockquote: blockComponent("blockquote", "blockquote"),
  ul: listComponent("ul"),
  ol: listComponent("ol"),
  table({ node, children, ...rest }: BlockProps) {
    const decoration = useDecoration("table", node);
    // A table cannot hold the block action itself — a span is not valid inside <table> — so the
    // action moves to a wrapper, which then carries the block's class and order as well.
    return (
      <>
        {decoration?.action ? (
          <div
            className={cn("markdown-diff-table-block", decoration.className)}
            style={decoration.style}
          >
            {decoration.action}
            <table {...rest}>{children}</table>
          </div>
        ) : (
          <table
            {...rest}
            className={cn(rest.className, decoration?.className)}
            style={decoration?.style}
          >
            {children}
          </table>
        )}
        {decoration?.after}
      </>
    );
  },
  tr({ node, children, ...rest }: BlockProps) {
    const decoration = useDecoration("table-row", node);
    const cells = Children.toArray(children);
    const lastCell = cells.at(-1);
    // A table row keeps the button inline in its last cell, for the same reason.
    const rowChildren =
      decoration?.action && isValidElement<{ children?: ReactNode }>(lastCell)
        ? [
            ...cells.slice(0, -1),
            cloneElement(
              lastCell,
              undefined,
              lastCell.props.children,
              decoration.action,
            ),
          ]
        : children;
    const row = (
      <tr
        {...rest}
        className={cn(rest.className, decoration?.className)}
        style={decoration?.style}
      >
        {rowChildren}
      </tr>
    );
    return decoration?.after ? (
      <>
        {row}
        <tr>
          <td colSpan={100}>{decoration.after}</td>
        </tr>
      </>
    ) : (
      row
    );
  },
  pre({ node, children, ...rest }: BlockProps) {
    const chart = node ? markdownMermaidChart(node) : null;
    const decoration = useDecoration(
      chart === null ? "code-block" : "mermaid",
      node,
    );
    if (chart !== null) {
      return (
        <>
          <div
            className={cn(
              "markdown-mermaid-block flex items-start gap-1",
              decoration?.className,
            )}
            style={decoration?.style}
          >
            {decoration?.action}
            <MermaidDiagram chart={chart} className="min-w-0 flex-1" />
          </div>
          {decoration?.after}
        </>
      );
    }
    return (
      <>
        <pre
          {...rest}
          className={cn(rest.className, decoration?.className)}
          style={decoration?.style}
        >
          {decoration?.action}
          {children}
        </pre>
        {decoration?.after}
      </>
    );
  },
  img({
    node,
    src,
    alt,
    title,
  }: BlockProps & { src?: string; alt?: string; title?: string }) {
    const decoration = useDecoration("image", node);
    if (!src) return null;
    const image = <MarkdownImage src={src} alt={alt} title={title} />;
    const rendered = decoration?.className ? (
      <span
        className={cn("markdown-diff-image-block", decoration.className)}
        style={decoration.style}
      >
        {decoration.action}
        {image}
      </span>
    ) : (
      <span style={decoration?.style}>
        {decoration?.action}
        {image}
      </span>
    );
    return decoration?.after ? (
      <>
        {rendered}
        {decoration.after}
      </>
    ) : (
      rendered
    );
  },
  a({
    href,
    title,
    children,
  }: {
    href?: string;
    title?: string;
    children?: ReactNode;
  }) {
    return (
      <MarkdownLink href={href} title={title}>
        {children}
      </MarkdownLink>
    );
  },
} as Components;

const JSX_OPTIONS: Options = {
  Fragment,
  components: COMPONENTS,
  ignoreInvalidStyle: true,
  jsx,
  jsxs,
  passKeys: true,
  passNode: true,
} as Options;

/** One parsed Markdown document, split into the blocks the diff draws. */
export type MarkdownDiffDocumentModel = {
  topLevel: MarkdownHastBlockTree[];
  blocks: MarkdownRenderedBlock[];
};

/** Parse one side of the diff. The parse is document-wide and happens once per source. */
export function useMarkdownDiffDocument(
  source: string,
): MarkdownDiffDocumentModel {
  return useMemo(() => {
    const topLevel = markdownHastTopLevel(markdownHast(source));
    return { topLevel, blocks: topLevel.flatMap((entry) => entry.blocks) };
  }, [source]);
}

function resolve(
  entry: MarkdownHastBlockTree,
  decorations: MarkdownDiffDecorations,
  selectedKey: string | null,
  composer: ReactNode,
): ReadonlyMap<string, ResolvedDecoration> {
  const resolved = new Map<string, ResolvedDecoration>();
  for (const key of entry.keys) {
    const decoration = decorations.get(key);
    if (!decoration) continue;
    const selected = key === selectedKey;
    resolved.set(key, {
      className: cn(
        decoration.className,
        selected && "markdown-diff-block-selected",
      ),
      style: decoration.style,
      action: decoration.action,
      after: decoration.after?.(selected ? composer : null),
    });
  }
  return resolved;
}

const MarkdownDiffBlock = memo(function MarkdownDiffBlock({
  entry,
  decorations,
  selectedKey,
  composer,
}: {
  entry: MarkdownHastBlockTree;
  decorations: MarkdownDiffDecorations;
  selectedKey: string | null;
  composer: ReactNode;
}) {
  // The hast node is stable for as long as the source is, so the conversion — the expensive half
  // of rendering — survives every decoration change.
  const element = useMemo(
    () => toJsxRuntime(entry.node, JSX_OPTIONS),
    [entry.node],
  );
  const value = useMemo(
    () => resolve(entry, decorations, selectedKey, composer),
    [entry, decorations, selectedKey, composer],
  );
  return (
    <DecorationContext.Provider value={value}>
      {element}
    </DecorationContext.Provider>
  );
});

// Memoized so the side that does not hold the selection keeps its whole document as it is while
// the composer's draft changes.
export const MarkdownDiffDocument = memo(function MarkdownDiffDocument({
  document,
  className,
  decorations,
  selectedKey,
  composer,
}: {
  document: MarkdownDiffDocumentModel;
  className?: string;
  decorations: MarkdownDiffDecorations;
  /** Key of the block holding the current selection, or null when nothing is selected here. */
  selectedKey: string | null;
  composer: ReactNode;
}) {
  return (
    <div className={cn("typeset", className)}>
      <MarkdownLightboxProvider>
        {document.topLevel.map((entry, index) => {
          const holdsSelection =
            selectedKey != null && entry.keys.has(selectedKey);
          return (
            <MarkdownDiffBlock
              // Blocks are identified by position in the document; the source itself is the
              // document's identity, so a changed source replaces the whole list.
              key={index}
              entry={entry}
              decorations={decorations}
              selectedKey={holdsSelection ? selectedKey : null}
              composer={holdsSelection ? composer : null}
            />
          );
        })}
      </MarkdownLightboxProvider>
    </div>
  );
});
