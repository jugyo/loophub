// One line per finding of a review that requested changes, for the review dialog's summary mode
// (#2557). The Verify contract has a request_changes body list its blocking findings under a
// "## Blocking" heading, one top-level list item each with a one-line summary first; this reads
// those first lines back. A body without that section yields nothing — its detail stays in detailed
// mode rather than being guessed at here.

const BLOCKING_HEADING = /^#{1,6}\s+blocking\s*#*$/i;
const HEADING = /^(#{1,6})\s/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function reviewBlockerLines(body: string): string[] {
  const items: string[] = [];
  let sectionLevel: number | null = null;
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    // Skip fenced code blocks; a fence closes only on the same character, at least as long.
    const fenceMark = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (
        fenceMark?.[0] === fence[0] &&
        fenceMark.length >= fence.length &&
        line.trim() === fenceMark
      )
        fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      continue;
    }
    const trimmed = line.trim();
    if (BLOCKING_HEADING.test(trimmed)) {
      sectionLevel = HEADING.exec(trimmed)![1].length;
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading && sectionLevel !== null && heading[1].length <= sectionLevel)
      sectionLevel = null;
    if (sectionLevel === null) continue;
    // Top-level items only: an indented line is a nested item or the item's own detail.
    const item = /^\s/.test(line) ? undefined : LIST_ITEM.exec(line)?.[1];
    const text = item === undefined ? "" : clean(item);
    if (text) items.push(text);
  }
  return items;
}

function clean(text: string): string {
  return text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
