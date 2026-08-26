import { describe, expect, it } from "#loophub-test";

import {
  detectSyntaxLanguage,
  syntaxHighlightDiff,
  tokenizeSyntax,
  tokenizeSyntaxWithState,
} from "./syntax-highlight.ts";

describe("syntax-highlight", () => {
  it("拡張子から対応言語を判定する", () => {
    expect(detectSyntaxLanguage("src/app.ts")).toBe("typescript");
    expect(detectSyntaxLanguage("src/app.tsx")).toBe("tsx");
    expect(detectSyntaxLanguage("src/app.js")).toBe("javascript");
    expect(detectSyntaxLanguage("src/app.jsx")).toBe("jsx");
    expect(detectSyntaxLanguage("docs/README.md")).toBe("markdown");
    expect(detectSyntaxLanguage("src/{old.js => new.ts}")).toBe("typescript");
    expect(detectSyntaxLanguage("image.png")).toBeNull();
  });

  it("TypeScript の主要 token を生成する", () => {
    expect(
      tokenizeSyntax(
        "async function run(value: string) { return value as string; }",
        "typescript",
      )
        .filter((item) => item.kind === "keyword")
        .map((item) => item.text),
    ).toEqual(["async", "function", "return", "as"]);
  });

  it("完全な blob の state を使って hunk 先頭のコメントを継続する", () => {
    const patch = "@@ -2,2 +2,2 @@\n- * old\n+ * new\n  */";
    const syntax = syntaxHighlightDiff(
      "src/app.ts",
      patch,
      "/* start\n * old\n */\n",
      "/* start\n * new\n */\n",
    );

    expect(syntax?.language).toBe("typescript");
    expect(syntax?.lines[1]?.old).toEqual([
      { kind: "comment", text: " * old" },
    ]);
    expect(syntax?.lines[2]?.new).toEqual([
      { kind: "comment", text: " * new" },
    ]);
  });

  it("複数行コメントの state を次の行へ返す", () => {
    const result = tokenizeSyntaxWithState("/* start", "typescript");
    expect(result.state.inBlockComment).toBe(true);
    expect(
      tokenizeSyntaxWithState(" continuation */", "typescript", result.state)
        .tokens,
    ).toEqual([{ kind: "comment", text: " continuation */" }]);
  });

  it("未対応形式では token を生成しない", () => {
    expect(
      syntaxHighlightDiff(
        "image.png",
        "Binary files differ",
        undefined,
        undefined,
      ),
    ).toBeNull();
  });
});
