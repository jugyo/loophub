import { describe, expect, it } from "#loophub-test";
import { reviewBlockerLines } from "@/lib/review-blockers";

describe("reviewBlockerLines", () => {
  it("takes the first line of each top-level item under the Blocking heading", () => {
    const body = [
      "full review. Two blockers.",
      "",
      "## Blocking",
      "",
      "- **Resizing** loses the chosen width (`pane-width.ts:45`)",
      "  The resize handler clamps the stored width.",
      "  - a nested note",
      "2. The handle has no label",
      "",
      "Closing paragraph of the section.",
      "",
      "### Why it matters",
      "",
      "- still inside the Blocking section",
      "",
      "## Non-blocking",
      "",
      "- a nit",
    ].join("\n");
    expect(reviewBlockerLines(body)).toEqual([
      "Resizing loses the chosen width (pane-width.ts:45)",
      "The handle has no label",
      "still inside the Blocking section",
    ]);
  });

  it("reads a body with CRLF line endings", () => {
    expect(reviewBlockerLines("## Blocking\r\n\r\n- A\r\n- B\r\n")).toEqual([
      "A",
      "B",
    ]);
  });

  it("matches the heading at any level and in any case", () => {
    expect(reviewBlockerLines("### blocking ###\n\n- A")).toEqual(["A"]);
  });

  it("returns nothing for a body without a Blocking section", () => {
    for (const body of [
      "partial review.\n\nThe toggle loses focus on close.",
      "## Findings\n\n- [blocking] A",
      "## blocking 1 — A\n\n- detail",
      "## Blocking findings\n\n- A",
      "",
    ]) {
      expect(reviewBlockerLines(body)).toEqual([]);
    }
  });

  it("ignores list items and headings inside code fences", () => {
    const body = [
      "## Blocking",
      "",
      "```md",
      "~~~",
      "## Detail",
      "- inside code",
      "    ```",
      "```",
      "- outside code",
    ].join("\n");
    expect(reviewBlockerLines(body)).toEqual(["outside code"]);
  });

  it("stays fast on a line of long whitespace", () => {
    const started = performance.now();
    reviewBlockerLines(`## Blocking\n\n#${" ".repeat(20000)}x\n- A`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
