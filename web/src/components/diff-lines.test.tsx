import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DiffLines } from "./diff-lines";

describe("DiffLines", () => {
  it("追加行と削除行を緑と赤の背景で表示する", () => {
    const { container } = render(
      <DiffLines
        filename="src/example.ts"
        patch={
          "@@ -1,2 +1,2 @@\n-const oldValue = true;\n+const newValue = false;"
        }
      />,
    );

    const rows = container.querySelectorAll(".pr-diff > span");
    expect(rows[1]?.className).toContain("bg-red-100");
    expect(rows[2]?.className).toContain("bg-green-100");
  });

  it("バイナリ差分の先頭文字を欠落させず表示する", () => {
    const source = "Binary files a/image.png and b/image.png differ";
    const { container } = render(
      <DiffLines filename="image.png" patch={source} />,
    );

    expect(container.querySelector(".pr-diff")?.textContent).toBe(source);
    expect(container.querySelector(".pr-diff-line-content")).toBeNull();
  });
});
