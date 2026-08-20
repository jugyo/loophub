import { describe, expect, it } from "vitest";
import {
  markdownHast,
  markdownHastBlocks,
  markdownHastTopLevel,
  markdownMermaidChart,
} from "./markdown-hast";

describe("markdownHastBlocks", () => {
  it("reports source ranges for commentable rendered blocks in document order", () => {
    const source = [
      "# Heading",
      "",
      "Paragraph",
      "",
      "> Quote",
      "> continued",
      "",
      "- item",
      "  - nested",
      "",
      "```ts",
      "code",
      "```",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "![alt](image.png)",
      "",
      "```mermaid",
      "graph TD;",
      "```",
    ].join("\n");

    expect(markdownHastBlocks(markdownHast(source))).toEqual([
      { kind: "heading", sourceRange: { startLine: 1, endLine: 1 } },
      { kind: "paragraph", sourceRange: { startLine: 3, endLine: 3 } },
      { kind: "blockquote", sourceRange: { startLine: 5, endLine: 6 } },
      { kind: "paragraph", sourceRange: { startLine: 5, endLine: 6 } },
      { kind: "list", sourceRange: { startLine: 8, endLine: 9 } },
      { kind: "list-item", sourceRange: { startLine: 8, endLine: 9 } },
      { kind: "list", sourceRange: { startLine: 9, endLine: 9 } },
      { kind: "list-item", sourceRange: { startLine: 9, endLine: 9 } },
      { kind: "code-block", sourceRange: { startLine: 11, endLine: 13 } },
      { kind: "table", sourceRange: { startLine: 15, endLine: 17 } },
      { kind: "table-row", sourceRange: { startLine: 15, endLine: 15 } },
      { kind: "table-row", sourceRange: { startLine: 17, endLine: 17 } },
      { kind: "paragraph", sourceRange: { startLine: 19, endLine: 19 } },
      { kind: "image", sourceRange: { startLine: 19, endLine: 19 } },
      { kind: "mermaid", sourceRange: { startLine: 21, endLine: 23 } },
    ]);
  });

  it("names the source lines a GFM table's rows span", () => {
    const source =
      "| Header | Value |\n| --- | --- |\n| first | row |\n| second | row |";
    expect(markdownHastBlocks(markdownHast(source))).toEqual([
      { kind: "table", sourceRange: { startLine: 1, endLine: 4 } },
      { kind: "table-row", sourceRange: { startLine: 1, endLine: 1 } },
      { kind: "table-row", sourceRange: { startLine: 3, endLine: 3 } },
      { kind: "table-row", sourceRange: { startLine: 4, endLine: 4 } },
    ]);
  });
});

describe("markdownHastTopLevel", () => {
  it("splits the document into top-level nodes that keep their nested blocks", () => {
    const tree = markdownHast("# Heading\n\n- item\n  - nested\n");
    const elements = markdownHastTopLevel(tree).filter(
      (entry) => entry.node.type === "element",
    );

    expect(elements.map((entry) => entry.blocks.map((b) => b.kind))).toEqual([
      ["heading"],
      ["list", "list-item", "list", "list-item"],
    ]);
    expect([...elements[1].keys]).toContain("list-item:4:4");
  });

  it("resolves a link reference definition declared elsewhere in the document", () => {
    // The definition is its own top-level node, so a per-block parse could not resolve the link.
    const tree = markdownHast(
      "See [the docs][ref].\n\n[ref]: https://example.com\n",
    );
    expect(JSON.stringify(tree)).toContain("https://example.com");
  });
});

describe("markdownHast", () => {
  it("escapes embedded raw HTML instead of keeping it as markup (XSS-safe)", () => {
    const tree = markdownHast('<img src=x onerror="alert(1)">');
    expect(JSON.stringify(tree)).not.toContain('"raw"');
    expect(markdownHastBlocks(tree).some((b) => b.kind === "image")).toBe(
      false,
    );
  });

  it("drops a link URL whose protocol is not safe", () => {
    const tree = markdownHast("[x](javascript:alert%281%29)");
    expect(JSON.stringify(tree)).not.toContain("javascript:");
  });
});

describe("markdownMermaidChart", () => {
  it("returns the chart text of a ```mermaid fenced block and null for other code", () => {
    const pre = (source: string) => {
      const node = markdownHast(source).children.find(
        (child) => child.type === "element" && child.tagName === "pre",
      );
      if (node?.type !== "element") throw new Error("no pre element");
      return node;
    };
    expect(
      markdownMermaidChart(pre("```mermaid\ngraph TD;\nA-->B;\n```")),
    ).toBe("graph TD;\nA-->B;");
    expect(markdownMermaidChart(pre("```ts\nconst x = 1;\n```"))).toBeNull();
  });
});
