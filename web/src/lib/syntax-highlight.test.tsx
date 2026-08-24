import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SyntaxHighlightedCode } from "./syntax-highlight";

describe("SyntaxHighlightedCode", () => {
  it("backend の token を class 付きで描画する", () => {
    const source = 'const message: string = "hello"; // greeting';
    const { container } = render(
      <SyntaxHighlightedCode
        code={source}
        language="typescript"
        tokens={[
          { kind: "keyword", text: "const" },
          { kind: "plain", text: " message: " },
          { kind: "type", text: "string" },
          { kind: "plain", text: " = " },
          { kind: "string", text: '"hello"' },
          { kind: "plain", text: "; " },
          { kind: "comment", text: "// greeting" },
        ]}
      />,
    );

    expect(container.querySelector('[data-syntax-language="typescript"]')).toBe(
      container.firstElementChild,
    );
    expect(
      container.querySelector('[data-syntax-token="keyword"]')?.textContent,
    ).toBe("const");
    expect(container.querySelector(".sr-only")?.textContent).toBe(source);
  });

  it("token がない場合は元のテキストへフォールバックする", () => {
    const source = "const value = 1;";
    const { container } = render(
      <SyntaxHighlightedCode code={source} language="typescript" />,
    );

    expect(container.textContent).toBe(source);
    expect(container.querySelector("[data-syntax-language]")).toBeNull();
  });
});
