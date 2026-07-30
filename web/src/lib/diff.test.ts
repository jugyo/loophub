import { describe, expect, it } from "vitest";
import { classifyDiffLine, parsePatch, parsePositionedPatch } from "./diff";

describe("classifyDiffLine", () => {
  it("classifies hunk headers", () => {
    expect(classifyDiffLine("@@ -1,3 +1,11 @@ foo")).toBe("hunk");
  });

  it("classifies added and removed lines", () => {
    expect(classifyDiffLine("+const x = 1;")).toBe("add");
    expect(classifyDiffLine("-const x = 0;")).toBe("del");
  });

  it("classifies file-header markers as meta, not add/del", () => {
    expect(classifyDiffLine("+++ b/src/a.ts")).toBe("meta");
    expect(classifyDiffLine("--- a/src/a.ts")).toBe("meta");
    expect(classifyDiffLine("diff --git a/x b/x")).toBe("meta");
    expect(classifyDiffLine("index abc..def 100644")).toBe("meta");
    expect(classifyDiffLine("\\ No newline at end of file")).toBe("meta");
  });

  it("classifies everything else as context", () => {
    expect(classifyDiffLine(" unchanged")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
  });
});

describe("parsePositionedPatch", () => {
  it("tracks old and new line numbers across context and changes", () => {
    expect(
      parsePositionedPatch(
        "@@ -4,3 +7,4 @@\n keep\n-before\n+after\n+extra\n tail",
      ),
    ).toEqual([
      {
        kind: "hunk",
        text: "@@ -4,3 +7,4 @@",
        oldLine: null,
        newLine: null,
      },
      { kind: "context", text: " keep", oldLine: 4, newLine: 7 },
      { kind: "del", text: "-before", oldLine: 5, newLine: null },
      { kind: "add", text: "+after", oldLine: null, newLine: 8 },
      { kind: "add", text: "+extra", oldLine: null, newLine: 9 },
      { kind: "context", text: " tail", oldLine: 6, newLine: 10 },
    ]);
  });
});

describe("parsePatch", () => {
  it("returns no lines for an empty or absent patch", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch(undefined)).toEqual([]);
    expect(parsePatch(null)).toEqual([]);
  });

  it("splits a patch into classified lines", () => {
    const patch = "@@ -1,2 +1,3 @@\n context\n-old\n+new";
    expect(parsePatch(patch)).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
      { kind: "context", text: " context" },
      { kind: "del", text: "-old" },
      { kind: "add", text: "+new" },
    ]);
  });
});

describe("parsePositionedPatch", () => {
  it("leaves copy metadata before the first hunk unpositioned", () => {
    const lines = parsePositionedPatch(
      [
        "similarity index 100%",
        "copy from source.txt",
        "copy to copy.txt",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
      ].join("\n"),
    );

    expect(lines.slice(0, 3)).toEqual([
      {
        kind: "meta",
        text: "similarity index 100%",
        oldLine: null,
        newLine: null,
      },
      {
        kind: "meta",
        text: "copy from source.txt",
        oldLine: null,
        newLine: null,
      },
      {
        kind: "meta",
        text: "copy to copy.txt",
        oldLine: null,
        newLine: null,
      },
    ]);
    expect(lines.slice(4)).toEqual([
      { kind: "add", text: "+one", oldLine: null, newLine: 1 },
      { kind: "add", text: "+two", oldLine: null, newLine: 2 },
    ]);
  });
});
