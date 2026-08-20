// Parse Markdown once per document, then hand out its top-level blocks.
//
// The rendered Markdown diff draws one block at a time so that selecting a range or opening a
// comment composer re-renders only the block it belongs to. Parsing still has to be document
// wide — link reference definitions and footnotes are document scoped — so the source is parsed
// here exactly once and only the hast → React conversion happens per block.
//
// The pipeline mirrors react-markdown's own (remark-parse → remark-gfm → remark-rehype, then its
// url sanitizing and raw-node handling), so a document rendered block by block matches what
// <Markdown> produces for the same source.
//
// XSS: rehype-raw is not used, so embedded HTML arrives as `raw` nodes and is turned back into
// literal text below. Keep it that way — do not add rehype-raw.

import type { Element, Nodes, Root, RootContent } from "hast";
import { urlAttributes } from "html-url-attributes";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import {
  type MarkdownRenderedBlock,
  type MarkdownRenderedBlockKind,
  markdownRenderedBlock,
  renderedBlockKey,
} from "@/lib/markdown-source-map";

// Same as react-markdown's defaultUrlTransform: everything relative is kept, and an absolute URL
// is kept only when its protocol is one of these.
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const BLOCK_KINDS: Record<string, MarkdownRenderedBlockKind> = {
  p: "paragraph",
  ul: "list",
  ol: "list",
  li: "list-item",
  blockquote: "blockquote",
  pre: "code-block",
  table: "table",
  tr: "table-row",
  img: "image",
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true });

/** Make a URL safe, the same way react-markdown does. */
export function markdownUrlTransform(value: string): string {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");

  if (
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_PROTOCOL.test(value.slice(0, colon))
  ) {
    return value;
  }
  return "";
}

/** Parse one Markdown document into the hast tree the block renderer draws from. */
export function markdownHast(source: string): Root {
  const tree = processor.runSync(processor.parse(source)) as Root;
  visit(tree, (node, index, parent) => {
    if (node.type === "raw" && parent && typeof index === "number") {
      parent.children[index] = { type: "text", value: node.value };
      return index;
    }
    if (node.type === "element") {
      for (const key of Object.keys(urlAttributes)) {
        if (!Object.hasOwn(node.properties, key)) continue;
        const test = urlAttributes[key];
        if (test !== null && !test.includes(node.tagName)) continue;
        node.properties[key] = markdownUrlTransform(
          String(node.properties[key] || ""),
        );
      }
    }
  });
  return tree;
}

/**
 * Chart text of a ```mermaid fenced block, or null when the element is not one.
 *
 * remark-rehype turns a fenced block into `<pre><code class="language-mermaid">…</code></pre>`;
 * the trailing newline it adds is not part of the chart.
 */
export function markdownMermaidChart(node: Element): string | null {
  if (node.tagName !== "pre" || node.children.length !== 1) return null;
  const code = node.children[0];
  if (code.type !== "element" || code.tagName !== "code") return null;
  const className = code.properties.className;
  const names = Array.isArray(className)
    ? className.map(String)
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];
  if (!names.includes("language-mermaid")) return null;
  const text = code.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("");
  return text.replace(/\n$/, "");
}

/** The rendered-block kind an element stands for, or null when it is not a commentable block. */
export function markdownBlockKind(
  node: Element,
): MarkdownRenderedBlockKind | null {
  if (HEADINGS.has(node.tagName)) return "heading";
  if (node.tagName === "pre") {
    return markdownMermaidChart(node) === null ? "code-block" : "mermaid";
  }
  return BLOCK_KINDS[node.tagName] ?? null;
}

/**
 * Every commentable block under `node`, in document order.
 *
 * The order matches the order React renders the elements in, which is what
 * `markdownDiffAnnotations` and `markdownDiffFeedbackPlacements` assume.
 */
export function markdownHastBlocks(node: Nodes): MarkdownRenderedBlock[] {
  const blocks: MarkdownRenderedBlock[] = [];
  visit(node, "element", (element: Element) => {
    const kind = markdownBlockKind(element);
    if (kind) blocks.push(markdownRenderedBlock(kind, element));
  });
  return blocks;
}

/** The top-level nodes of a document, each with the blocks it contains. */
export type MarkdownHastBlockTree = {
  node: RootContent;
  blocks: MarkdownRenderedBlock[];
  /** Keys of `blocks`, so a renderer can tell which subtree a block belongs to. */
  keys: ReadonlySet<string>;
};

export function markdownHastTopLevel(tree: Root): MarkdownHastBlockTree[] {
  return tree.children.map((node) => {
    const blocks = markdownHastBlocks(node);
    return { node, blocks, keys: new Set(blocks.map(renderedBlockKey)) };
  });
}
