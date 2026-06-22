import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./markdown";

describe("Markdown edge cases", () => {
  it("handles empty strings without crashing", () => {
    const { container } = render(<Markdown>{""}</Markdown>);
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });

  it("handles whitespace-only strings", () => {
    const { container } = render(<Markdown>{"\n  \n"}</Markdown>);
    expect(container.querySelector(".markdown-body")).not.toBeNull();
  });

  it("handles very long markdown without crashing", () => {
    const longText = "# Header\n" + "paragraph\n\n".repeat(1000);
    const { container } = render(<Markdown>{longText}</Markdown>);
    expect(container.querySelector("h1")).not.toBeNull();
  });

  it("handles special unicode characters", () => {
    const { container } = render(<Markdown>{"emoji: 🎉 unicode: 你好"}</Markdown>);
    expect(container.textContent).toContain("🎉");
    expect(container.textContent).toContain("你好");
  });
});
