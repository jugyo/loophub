import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DiffLines } from "./diff-lines";

describe("DiffLines", () => {
  it("追加行と削除行だけを案Aの淡い背景で表示する", () => {
    const { container } = render(
      <DiffLines
        filename="src/example.ts"
        patch={
          "@@ -1,3 +1,3 @@\n context\n-const oldValue = true;\n+const newValue = false;"
        }
      />,
    );

    const rows = container.querySelectorAll(".pr-diff > span");
    expect(rows[1]?.className).toBe("block px-3 ");
    expect(rows[1]?.className).not.toContain("bg-red-50");
    expect(rows[1]?.className).not.toContain("bg-green-50");
    expect(rows[2]?.className).toContain("bg-red-50");
    expect(rows[2]?.className).toContain("dark:bg-[#2b1b1e]");
    expect(rows[2]?.className).toContain("text-foreground");
    expect(rows[3]?.className).toContain("bg-green-50");
    expect(rows[3]?.className).toContain("dark:bg-[#13251d]");
    expect(rows[3]?.className).toContain("text-foreground");
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
