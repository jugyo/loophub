import { describe, expect, it } from "vitest";

import { hasMarkdownImage } from "./markdown-images";

describe("hasMarkdownImage", () => {
  it("detects an attached screenshot embedded in a body", () => {
    expect(
      hasMarkdownImage(
        `## Evidence\n\n![shot.png](/attachments/${"a".repeat(64)})\n`,
      ),
    ).toBe(true);
  });

  it("detects an image with an empty alt text or a title", () => {
    expect(hasMarkdownImage("![](/attachments/abc)")).toBe(true);
    expect(hasMarkdownImage('![shot](/attachments/abc "After")')).toBe(true);
  });

  it("ignores a body without an image", () => {
    expect(hasMarkdownImage("")).toBe(false);
    expect(hasMarkdownImage("Looks good.")).toBe(false);
  });

  it("ignores a plain link, including a linked document attachment", () => {
    expect(
      hasMarkdownImage(`[findings.md](/attachments/${"b".repeat(64)})`),
    ).toBe(false);
  });

  it("ignores image markdown that is only quoted in fenced code", () => {
    expect(
      hasMarkdownImage("Embed it like this:\n\n```md\n![shot.png](/x)\n```\n"),
    ).toBe(false);
    expect(hasMarkdownImage("```\n![shot.png](/x)\n")).toBe(false);
  });

  it("still detects an image outside the fenced code around it", () => {
    expect(
      hasMarkdownImage("```md\n![quoted](/x)\n```\n\n![shot.png](/y)\n"),
    ).toBe(true);
  });

  it("does not treat raw HTML as an image, since bodies escape it", () => {
    expect(hasMarkdownImage('<img src="/attachments/abc">')).toBe(false);
  });
});
