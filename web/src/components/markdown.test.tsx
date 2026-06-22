import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("renders headings, emphasis and links", () => {
    const { container } = render(
      <Markdown>{"# Title\n\n**bold** _italic_ ~~struck~~ [link](https://example.com)"}</Markdown>,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("del")?.textContent).toBe("struck");
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.com");
  });

  it("renders fenced code blocks", () => {
    const { container } = render(
      <Markdown>{"```ts\nconst x = 1;\n```"}</Markdown>,
    );
    const pre = container.querySelector("pre code");
    expect(pre?.textContent).toContain("const x = 1;");
  });

  it("renders GFM tables", () => {
    const { container } = render(
      <Markdown>{"| a | b |\n| - | - |\n| 1 | 2 |"}</Markdown>,
    );
    expect(container.querySelectorAll("table th")).toHaveLength(2);
    expect(container.querySelectorAll("table td")).toHaveLength(2);
  });

  it("renders GFM task lists with checkboxes", () => {
    const { container } = render(
      <Markdown>{"- [x] done\n- [ ] todo"}</Markdown>,
    );
    const boxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    // checkboxes are disabled (display only, no editing)
    expect(boxes[0].disabled).toBe(true);
  });

  it("escapes embedded raw HTML instead of rendering it (XSS-safe)", () => {
    const { container } = render(
      <Markdown>{'<img src=x onerror="alert(1)"> <script>alert(1)</script>'}</Markdown>,
    );
    // No raw HTML is injected: the markup is escaped, so no <img>/<script> nodes.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // The source appears as visible text.
    expect(container.textContent).toContain("alert(1)");
  });
});
