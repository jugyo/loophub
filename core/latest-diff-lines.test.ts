import { describe, expect, it } from "#loophub-test";
import type { DiffFile } from "./git.ts";
import { latestChangedLines } from "./latest-diff-lines.ts";

const file = (patch: string): DiffFile => ({
  filename: "a.txt",
  headFilename: "a.txt",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch,
});

describe("latestChangedLines", () => {
  it("marks only additions and deletions repeated by the head commit", () => {
    const pull = file(
      "@@ -1,3 +1,3 @@\n-old\n+earlier\n keep\n-remove-now\n+latest",
    );
    const latest = file("@@ -2,2 +2,2 @@\n keep\n-remove-now\n+latest");

    expect(latestChangedLines(pull, [latest])).toEqual(new Set([4, 5]));
  });

  it("does not mark context lines or files untouched by the head commit", () => {
    const pull = file("@@ -1 +1 @@\n-old\n+new");
    const latest = {
      ...file("@@ -1 +1 @@\n-x\n+y"),
      filename: "other.txt",
      headFilename: "other.txt",
    };
    expect([...latestChangedLines(pull, [latest])]).toEqual([]);
  });

  it("uses the surviving context to distinguish duplicate deletion text", () => {
    const pull = file("@@ -1,3 +1 @@\n-x\n keep\n-x");
    const latest = file("@@ -2,2 +2,1 @@\n keep\n-x");

    expect([...latestChangedLines(pull, [latest])]).toEqual([3]);
  });

  it("marks a complete group of equivalent consecutive deletions", () => {
    const patch = "@@ -1,3 +1 @@\n-x\n-x\n keep";

    expect(latestChangedLines(file(patch), [file(patch)])).toEqual(
      new Set([1, 2]),
    );
  });
});
