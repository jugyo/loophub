import { cleanup, render, waitFor } from "@testing-library/react";
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
});
