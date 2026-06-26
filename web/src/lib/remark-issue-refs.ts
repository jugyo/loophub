// remark plugin: turn `#123` references in Markdown text into links to the
// in-repo resolver route (/r/<owner>/<repo>/n/<number>). The resolver redirects
// to the issues or pulls route depending on the referenced entity's kind, so a
// `#n` is unambiguous (issues and PRs share one number space per repo).
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

const REF = /(?<![\w&/])#(\d+)\b/g;

export function remarkIssueRefs({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const base = `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/n`;

  function splitRefs(value: string): MdNode[] | null {
    REF.lastIndex = 0;
    const out: MdNode[] = [];
    let last = 0;
    let m = REF.exec(value);
    while (m !== null) {
      if (m.index > last) {
        out.push({ type: "text", value: value.slice(last, m.index) });
      }
      const num = m[1];
      out.push({
        type: "link",
        url: `${base}/${num}`,
        children: [{ type: "text", value: `#${num}` }],
      });
      last = m.index + m[0].length;
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
