// Whether a Markdown body renders at least one image (#2344). An attached screenshot reaches a
// body as inline image markdown (`![shot.png](/attachments/<sha256>)`), so matching that syntax is
// what "has a screenshot" means here: raw <img> HTML is escaped rather than rendered (see
// components/markdown.tsx), and reference-style images (`![alt][ref]`) are not produced by the
// attachment flow.

// Fenced code is stripped first so a body that only quotes image markdown as an example — Evidence
// snippets in a review read that way — does not count as carrying one. An unterminated fence runs
// to the end of the body, matching how it renders.
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const MARKDOWN_IMAGE = /!\[[^\]]*\]\([^)]*\)/;

export function hasMarkdownImage(source: string): boolean {
  return MARKDOWN_IMAGE.test(source.replace(FENCED_CODE, ""));
}
