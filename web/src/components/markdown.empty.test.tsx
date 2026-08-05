import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

// <Markdown> looks up the kinds of the `#n` numbers in the body through TanStack Query,
// so it needs a client even for bodies with no references.
function renderWithClient(ui: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

describe("Markdown edge cases", () => {
  it("handles empty strings without crashing", () => {
    const { container } = renderWithClient(<Markdown>{""}</Markdown>);
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });

  it("handles whitespace-only strings", () => {
    const { container } = renderWithClient(<Markdown>{"\n  \n"}</Markdown>);
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });

  it("handles very long markdown without crashing", () => {
    const longText = `# Header\n${"paragraph\n\n".repeat(1000)}`;
    const { container } = renderWithClient(<Markdown>{longText}</Markdown>);
    expect(container.querySelector("h1")).not.toBeNull();
  });

  it("handles special unicode characters", () => {
    const { container } = renderWithClient(
      <Markdown>{"emoji: 🎉 unicode: 你好"}</Markdown>,
    );
    expect(container.textContent).toContain("🎉");
    expect(container.textContent).toContain("你好");
  });
});
