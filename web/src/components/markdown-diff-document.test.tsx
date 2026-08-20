import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";

// MermaidDiagram itself is covered by mermaid-diagram.test.tsx; here we only need to confirm the
// diff renderer routes ```mermaid fenced blocks to it with the right chart text.
vi.mock("@/components/mermaid-diagram", () => ({
  MermaidDiagram: ({ chart }: { chart: string }) => (
    <div data-testid="mermaid-mock">{chart}</div>
  ),
}));

// The parse is the expensive half of rendering, so the tests below watch how often it runs.
vi.mock("@/lib/markdown-hast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/markdown-hast")>();
  return { ...actual, markdownHast: vi.fn(actual.markdownHast) };
});

import { markdownHast } from "@/lib/markdown-hast";
import {
  type MarkdownRenderedBlock,
  renderedBlockKey,
} from "@/lib/markdown-source-map";
import {
  type MarkdownDiffBlockDecoration,
  MarkdownDiffDocument,
  useMarkdownDiffDocument,
} from "./markdown-diff-document";

type Decorate = (
  block: MarkdownRenderedBlock,
) => MarkdownDiffBlockDecoration | null;

/**
 * Drives the document the way the diff pane does: decorations are built once per parsed document,
 * while the selection and the composer body change as the reader works.
 */
function Harness({
  source,
  decorate,
  selectKind,
}: {
  source: string;
  decorate: Decorate;
  /** Kind of the block the "select" button moves the selection to. */
  selectKind?: MarkdownRenderedBlock["kind"];
}) {
  const document = useMarkdownDiffDocument(source);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const decorations = useMemo(() => {
    const result = new Map<string, MarkdownDiffBlockDecoration>();
    for (const block of document.blocks) {
      const decoration = decorate(block);
      if (decoration) result.set(renderedBlockKey(block), decoration);
    }
    return result;
    // `decorate` is a stable test helper; the pane rebuilds this map only when the diff changes.
  }, [document]);
  const target = document.blocks.find((block) => block.kind === selectKind);
  return (
    <>
      <button
        type="button"
        onClick={() => setSelectedKey(target ? renderedBlockKey(target) : null)}
      >
        select
      </button>
      <MarkdownDiffDocument
        document={document}
        decorations={decorations}
        selectedKey={selectedKey}
        composer={
          <textarea
            aria-label="Diff comment"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        }
      />
    </>
  );
}

function renderDocument(
  source: string,
  decorate: Decorate = () => ({}),
  selectKind?: MarkdownRenderedBlock["kind"],
) {
  vi.mocked(markdownHast).mockClear();
  return render(
    <Harness source={source} decorate={decorate} selectKind={selectKind} />,
  );
}

const gutter = (block: MarkdownRenderedBlock): ReactNode => (
  <button type="button">Comment on {block.kind}</button>
);

describe("MarkdownDiffDocument", () => {
  it("renders the document's blocks with their decorations", () => {
    const { container } = renderDocument(
      "# Heading\n\nParagraph\n",
      (block) => ({
        className: `mapped-${block.kind}`,
        style: { order: 3 },
        action: gutter(block),
      }),
    );

    expect(container.querySelector("h1")?.className).toContain(
      "mapped-heading",
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "Comment on headingHeading",
    );
    expect(
      (container.querySelector("p") as HTMLElement | null)?.style.order,
    ).toBe("3");
  });

  it("keeps a Mermaid action inside the styled rendered block", () => {
    renderDocument("```mermaid\ngraph TD;\nA-->B;\n```", (block) => ({
      className: "mapped-mermaid",
      style: { order: 7 },
      action: gutter(block),
    }));

    const diagram = screen.getByTestId("mermaid-mock");
    expect(diagram.textContent).toBe("graph TD;\nA-->B;");
    const block = diagram.closest(".markdown-mermaid-block");
    expect(block?.classList).toContain("mapped-mermaid");
    expect((block as HTMLElement | null)?.style.order).toBe("7");
    expect(block?.querySelector("button")?.textContent).toBe(
      "Comment on mermaid",
    );
  });

  it("renders table row actions inside the last cell without changing table structure", () => {
    // The table action moves to a wrapper element, since a span is not valid inside <table>.
    const { container } = renderDocument(
      "| Header | Value |\n| --- | --- |\n| first | row |\n| second | row |",
      (block) =>
        block.kind === "table-row" && block.sourceRange?.startLine === 3
          ? {
              action: (
                <button type="button" aria-label="Comment on head lines 3-3">
                  +
                </button>
              ),
            }
          : {},
    );

    const table = container.querySelector("table");
    expect(table?.querySelectorAll("thead > tr")).toHaveLength(1);
    expect(table?.querySelectorAll("tbody > tr")).toHaveLength(2);
    expect(table?.querySelectorAll("thead > tr > th")).toHaveLength(2);
    expect(table?.querySelectorAll("tbody > tr > td")).toHaveLength(4);
    expect(
      table
        ?.querySelector('button[aria-label="Comment on head lines 3-3"]')
        ?.closest("td"),
    ).not.toBeNull();
  });

  it("marks the selected block and hosts the composer under it", () => {
    const { container } = renderDocument(
      "First\n\nSecond\n",
      (block) => ({ after: (composer) => composer, className: block.kind }),
      "paragraph",
    );

    expect(screen.queryByLabelText("Diff comment")).toBeNull();
    fireEvent.click(screen.getByText("select"));

    const selected = container.querySelector(".markdown-diff-block-selected");
    expect(selected?.textContent).toBe("First");
    expect(
      container.querySelectorAll(".markdown-diff-block-selected"),
    ).toHaveLength(1);
    expect(screen.getByLabelText("Diff comment")).not.toBeNull();
  });

  it("parses the source once, however often the selection or the draft changes", () => {
    renderDocument(
      "# Heading\n\nFirst\n\nSecond\n",
      () => ({ after: (composer) => composer }),
      "paragraph",
    );
    expect(vi.mocked(markdownHast)).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("select"));
    fireEvent.change(screen.getByLabelText("Diff comment"), {
      target: { value: "note" },
    });

    expect(screen.getByLabelText("Diff comment")).toHaveProperty(
      "value",
      "note",
    );
    expect(vi.mocked(markdownHast)).toHaveBeenCalledTimes(1);
  });

  it("keeps the other blocks' DOM nodes mounted while the selection moves", () => {
    // Re-rendering the whole document used to remount it, which dropped the preview's scroll
    // position (#352). Nothing but the selected block may be rebuilt now.
    const { container } = renderDocument(
      "# Heading\n\nFirst\n\n![alt](image.png)\n",
      () => ({ after: (composer) => composer }),
      "paragraph",
    );
    const heading = container.querySelector("h1");
    const image = container.querySelector("img");

    fireEvent.click(screen.getByText("select"));

    expect(container.querySelector("h1")).toBe(heading);
    expect(container.querySelector("img")).toBe(image);
  });

  it("escapes embedded raw HTML instead of rendering it (XSS-safe)", () => {
    const { container } = renderDocument(
      '<img src=x onerror="alert(1)"> <script>alert(1)</script>',
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("alert(1)");
  });
});
