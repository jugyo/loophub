import { describe, expect, it } from "vitest";
import { classifyDiffLine, parsePatch } from "./diff";

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
  });

  it("classifies everything else as context", () => {
    expect(classifyDiffLine(" unchanged")).toBe("context");
    expect(classifyDiffLine("")).toBe("context");
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
