import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { renderMock, initializeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  initializeMock: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMock,
    render: renderMock,
  },
}));

import { MermaidDiagram } from "./mermaid-diagram";

afterEach(() => {
  cleanup();
  renderMock.mockReset();
  initializeMock.mockReset();
});

describe("MermaidDiagram", () => {
  it("renders the SVG once mermaid.render resolves", async () => {
    renderMock.mockResolvedValue({ svg: '<svg role="img"></svg>' });
    const { container } = render(<MermaidDiagram chart="graph TD; A-->B;" />);

    await waitFor(() =>
      expect(container.querySelector(".mermaid-diagram svg")).not.toBeNull(),
    );
    expect(renderMock).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      "graph TD; A-->B;",
    );
  });

  it("falls back to the plain source plus an error message when rendering fails", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 1"));
    const { container, getByText } = render(
      <MermaidDiagram chart="not a diagram" />,
    );

    await waitFor(() =>
      expect(getByText(/Failed to render Mermaid diagram/)).toBeTruthy(),
    );
    expect(container.querySelector(".mermaid-diagram")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe(
      "not a diagram",
    );
  });

  it("retries the module load on the next mount after a load failure, instead of staying broken", async () => {
    // Simulate the dynamic `import("mermaid")` chain failing once (e.g. a transient network
    // blip) by having initialize() throw inside loadMermaid()'s `.then()`.
    initializeMock.mockImplementationOnce(() => {
      throw new Error("failed to fetch dynamically imported module");
    });
    const first = render(<MermaidDiagram chart="graph TD; A-->B;" />);
    await waitFor(() =>
      expect(first.getByText(/Failed to render Mermaid diagram/)).toBeTruthy(),
    );
    first.unmount();

    // A fresh mount must retry the import rather than replaying the cached rejection.
    renderMock.mockResolvedValue({ svg: '<svg role="img"></svg>' });
    const second = render(<MermaidDiagram chart="graph TD; A-->B;" />);
    await waitFor(() =>
      expect(
        second.container.querySelector(".mermaid-diagram svg"),
      ).not.toBeNull(),
    );
  });

  it("opens a lightbox with the diagram when clicked, and closes it via the close button", async () => {
    renderMock.mockResolvedValue({ svg: '<svg role="img"></svg>' });
    render(<MermaidDiagram chart="graph TD; A-->B;" />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Expand diagram" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand diagram" }));
    const dialog = screen.getByRole("dialog", { name: "Diagram preview" });
    expect(dialog.querySelector("svg")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the lightbox on Enter/Space from the keyboard", async () => {
    renderMock.mockResolvedValue({ svg: '<svg role="img"></svg>' });
    render(<MermaidDiagram chart="graph TD; A-->B;" />);

    const trigger = await waitFor(() =>
      screen.getByRole("button", { name: "Expand diagram" }),
    );
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(
      screen.getByRole("dialog", { name: "Diagram preview" }),
    ).toBeTruthy();
  });

  // mermaid namespaces everything it emits under the `renderId` passed to `mermaid.render()`,
  // including CSS selectors in its embedded <style> block (e.g. `#<renderId> .node rect{...}`) —
  // not just `id="..."` attributes and `url(#...)`/`href="#..."` references. Build the mock SVG
  // dynamically from the id the component actually passes in (`mockImplementation` receives it as
  // its first argument), so these tests exercise the real rewrite path rather than a hardcoded id.

  it("sizes the lightbox copy from the SVG's own viewBox instead of mermaid's squished inline width", async () => {
    // mermaid's useMaxWidth sizing writes `width="100%"` plus an inline `style="max-width: <the
    // diagram's natural width>px"` on the root <svg> — inline styles always win over a stylesheet
    // rule, and even once cleared, `width="100%"` alone resolves against this dialog's auto-sized
    // content box, not anything meaningful. Setting width explicitly from the viewBox is what
    // actually makes the diagram render at (up to) its natural size instead of staying squished.
    renderMock.mockImplementation((renderId: string) =>
      Promise.resolve({
        svg: `<svg id="${renderId}" style="max-width: 200px;" width="100%" viewBox="0 0 400 100"></svg>`,
      }),
    );
    render(<MermaidDiagram chart="graph TD; A-->B;" />);

    fireEvent.click(
      await waitFor(() =>
        screen.getByRole("button", { name: "Expand diagram" }),
      ),
    );
    const renderId = renderMock.mock.calls[0][0] as string;
    const dialog = screen.getByRole("dialog", { name: "Diagram preview" });
    await waitFor(() => {
      // Scope past the close button's own (id-less) icon svg to the diagram's copy.
      const style =
        dialog
          .querySelector(`svg#${renderId}-lightbox`)
          ?.getAttribute("style") ?? "";
      expect(style).toContain("width: 400px");
      expect(style).not.toContain("max-width");
    });
  });

  it("gives the lightbox copy of the SVG ids distinct from the inline copy, including CSS selectors in its embedded <style>", async () => {
    // Shape matches real mermaid output: a <style> block whose rules are scoped with a literal
    // `#<renderId>` selector prefix, plus a marker referenced via url(#...) — see mermaid's
    // compileCSS/createCssStyles.
    renderMock.mockImplementation((renderId: string) =>
      Promise.resolve({
        svg: `<svg id="${renderId}"><style>#${renderId}{font-size:16px;}#${renderId} .node rect{fill:#ECECFF;}</style><marker id="${renderId}_arrow"></marker><path marker-end="url(#${renderId}_arrow)"></path></svg>`,
      }),
    );
    const { container } = render(<MermaidDiagram chart="graph TD; A-->B;" />);
    await waitFor(() =>
      expect(container.querySelector(".mermaid-diagram svg")).not.toBeNull(),
    );
    const renderId = renderMock.mock.calls[0][0] as string;

    fireEvent.click(screen.getByRole("button", { name: "Expand diagram" }));
    const dialog = screen.getByRole("dialog", { name: "Diagram preview" });
    const diagramSvg = await waitFor(() => {
      const el = dialog.querySelector(`svg#${renderId}-lightbox`);
      expect(el).not.toBeNull();
      return el as SVGSVGElement;
    });

    const inlineIds = [
      ...container.querySelectorAll(".mermaid-diagram [id]"),
    ].map((el) => el.id);
    const lightboxIds = [...diagramSvg.querySelectorAll("[id]"), diagramSvg]
      .map((el) => el.id)
      .filter(Boolean);
    expect(inlineIds.length).toBeGreaterThan(0);
    for (const id of lightboxIds) {
      expect(inlineIds).not.toContain(id);
    }
    expect(diagramSvg.querySelector("path")?.getAttribute("marker-end")).toBe(
      `url(#${renderId}-lightbox_arrow)`,
    );
    // The <style> block's selectors must be rewritten too, or the lightbox copy renders unstyled
    // (its rules would still point at the original, still-mounted inline copy's id).
    const styleText = diagramSvg.querySelector("style")?.textContent ?? "";
    expect(styleText).toContain(`#${renderId}-lightbox`);
    expect(styleText).not.toContain(`#${renderId}{`);
    expect(styleText).not.toContain(`#${renderId} .node`);
  });

  it("closes the lightbox instead of leaving it open with stale content when the chart changes", async () => {
    renderMock.mockResolvedValue({ svg: '<svg role="img"></svg>' });
    const { rerender } = render(<MermaidDiagram chart="graph TD; A-->B;" />);

    fireEvent.click(
      await waitFor(() =>
        screen.getByRole("button", { name: "Expand diagram" }),
      ),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(<MermaidDiagram chart="graph TD; A-->C;" />);
    // The reload effect resets svg to null first (loading state), which must also close the
    // lightbox rather than leaving `expanded` true for it to silently reopen once the new
    // diagram resolves.
    expect(screen.queryByRole("dialog")).toBeNull();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Expand diagram" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open the lightbox when clicking a mermaid `click nodeId` link inside the diagram", async () => {
    // Mermaid renders `click nodeId "url"` directives as a real <a> around the node, even under
    // securityLevel "strict" — that link must navigate on its own, not also pop the lightbox.
    renderMock.mockResolvedValue({
      svg: '<svg><a xlink:href="https://example.com"><text>A</text></a></svg>',
    });
    const { container } = render(<MermaidDiagram chart="graph TD; A-->B;" />);
    await waitFor(() =>
      expect(container.querySelector(".mermaid-diagram svg")).not.toBeNull(),
    );

    fireEvent.click(container.querySelector("a text") as Element);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Clicking elsewhere in the diagram still opens it as normal.
    fireEvent.click(screen.getByRole("button", { name: "Expand diagram" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
