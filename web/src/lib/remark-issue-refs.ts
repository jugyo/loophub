// remark plugin: turn `#123` references in Markdown text into links to the referenced
// Issue or PR. A `#n` is unambiguous within a repo (issues and PRs share one number
// space) but its kind is not derivable from the source, so the caller resolves the kinds
// first (issueRefNumbers -> issues/refKinds) and passes them in as `kinds`. A known kind
// produces the canonical route — /r/<owner>/<repo>/issues/<n> or /pulls/<n> — so the href
// a reader copies is the URL the link lands on. A number with no entry (not yet resolved,
// or no such Issue/PR) is left as plain text: there is nothing to link it to.
//
// Scope guards (avoid false positives):
//   - only plain `text` nodes are rewritten; `code` / `inlineCode` are distinct
//     mdast node types holding their content in `value` (no text children), so
//     fenced and inline code are never touched.
//   - `heading`, `link`, and `linkReference` subtrees are skipped entirely, so
//     heading markers and (reference-style) link text are never (re-)linkified
//     — turning `#n` inside link text into a link would nest <a> inside <a>.
//   - the pattern matches `#` + digits at a word boundary, not preceded by a
//     word char, `&`, or `/` — so `#fff` (no digits), `&#39;` (HTML entity),
//     `abc#1`, and URL fragments like `path#1` do not match.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

export type IssueRefKind = "issue" | "pull";

const REF = /(?<![\w&/])#(\d+)\b/g;

/**
 * Numbers referenced as `#n` anywhere in a Markdown source, sorted and deduplicated.
 * Scanning the raw source rather than the parsed tree keeps this usable before rendering;
 * it over-matches the tree walk below (code spans, headings, link text), which only costs
 * a few extra numbers in the kind lookup.
 */
export function issueRefNumbers(source: string): number[] {
  REF.lastIndex = 0;
  const numbers = new Set<number>();
  let m = REF.exec(source);
  while (m !== null) {
    numbers.add(Number(m[1]));
    m = REF.exec(source);
  }
  return [...numbers].sort((a, b) => a - b);
}

export function remarkIssueRefs({
  owner,
  repo,
  kinds,
}: {
  owner: string;
  repo: string;
  kinds?: ReadonlyMap<number, IssueRefKind>;
}) {
  const base = `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  function refUrl(num: string): string | null {
    switch (kinds?.get(Number(num))) {
      case "pull":
        return `${base}/pulls/${num}`;
      case "issue":
        return `${base}/issues/${num}`;
      default:
        return null;
    }
  }

  function splitRefs(value: string): MdNode[] | null {
    REF.lastIndex = 0;
    const out: MdNode[] = [];
    let last = 0;
    let m = REF.exec(value);
    while (m !== null) {
      const num = m[1];
      const url = refUrl(num);
      // A ref with no known kind is skipped rather than linked, so it stays part of the
      // surrounding text span.
      if (url) {
        if (m.index > last) {
          out.push({ type: "text", value: value.slice(last, m.index) });
        }
        out.push({
          type: "link",
          url,
          children: [{ type: "text", value: `#${num}` }],
        });
        last = m.index + m[0].length;
      }
      m = REF.exec(value);
    }
    if (out.length === 0) return null;
    if (last < value.length) {
      out.push({ type: "text", value: value.slice(last) });
    }
    return out;
  }

  function walk(node: MdNode): void {
    if (!node.children) return;
    if (
      node.type === "heading" ||
      node.type === "link" ||
      node.type === "linkReference"
    ) {
      return;
    }
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (child.type === "text" && child.value) {
        const parts = splitRefs(child.value);
        if (parts) {
          node.children.splice(i, 1, ...parts);
          i += parts.length - 1;
        }
      } else {
        walk(child);
      }
    }
  }

  return (tree: MdNode) => {
    walk(tree);
  };
}
