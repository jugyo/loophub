// remark plugin: turn `#123` and `owner/repo#123` references in Markdown text into links to
// the referenced Issue or PR. A `#n` is unambiguous within a repo (issues and PRs share one
// number space) but its kind is not derivable from the source, so the caller resolves the kinds
// first (issueRefTargets -> issues/refKinds) and passes them in as `kinds`. A known kind
// produces the canonical route — /r/<owner>/<repo>/issues/<n> or /pulls/<n> — so the href
// a reader copies is the URL the link lands on. A reference with no entry (not yet resolved,
// no such Issue/PR, or a repo this hub does not host) is left as plain text: there is nothing
// to link it to.
//
// Scope guards (avoid false positives):
//   - only plain `text` nodes are rewritten; `code` / `inlineCode` are distinct
//     mdast node types holding their content in `value` (no text children), so
//     fenced and inline code are never touched.
//   - `heading`, `link`, and `linkReference` subtrees are skipped entirely, so
//     heading markers and (reference-style) link text are never (re-)linkified
//     — turning a reference inside link text into a link would nest <a> inside <a>.
//   - the pattern matches `#` + digits at a word boundary, not preceded by a
//     word char, `&`, or `/` — so `#fff` (no digits), `&#39;` (HTML entity),
//     `abc#1`, and URL fragments like `path#1` do not match. The same `/` rule
//     covers the `owner/repo#n` form: a repo path inside a URL is preceded by a
//     `/` (`github.com/owner/repo#1`), so it is not read as a reference.
//
// Beyond those, the kind lookup is the guard that matters: a reference only becomes a
// link when the repo it names is registered here and the number exists in it. Text that
// merely looks like `a/b#1` resolves to nothing and stays as it was written.

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

export type IssueRefKind = "issue" | "pull";

/** References in one Markdown source that point at the same repo ("owner/name"). */
export interface IssueRefTarget {
  repo: string;
  numbers: number[];
}

// Groups: 1-2 = owner and repo, present only for the `owner/repo#n` form; 3 = the number.
const REF =
  /(?<![\w&/])(?:([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*))?#(\d+)\b/g;

/** Key of one resolved reference: the repo it points at plus the number. */
export function issueRefKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/**
 * References in a Markdown source grouped by the repo they point at, each group's numbers
 * sorted and deduplicated and the groups sorted by repo, so the result is stable enough to key
 * a lookup by. `#n` points at `repo`, the repo the body is rendered for; `owner/repo#n` points
 * at the repo it names. Scanning the raw source rather than the parsed tree keeps this usable
 * before rendering; it over-matches the tree walk below (code spans, headings, link text),
 * which only costs a few extra numbers in the kind lookup.
 */
export function issueRefTargets(
  source: string,
  repo: string,
): IssueRefTarget[] {
  REF.lastIndex = 0;
  const byRepo = new Map<string, Set<number>>();
  let m = REF.exec(source);
  while (m !== null) {
    const target = m[1] ? `${m[1]}/${m[2]}` : repo;
    const numbers = byRepo.get(target) ?? new Set<number>();
    numbers.add(Number(m[3]));
    byRepo.set(target, numbers);
    m = REF.exec(source);
  }
  return [...byRepo]
    .map(([name, numbers]) => ({
      repo: name,
      numbers: [...numbers].sort((a, b) => a - b),
    }))
    .sort((a, b) => (a.repo < b.repo ? -1 : 1));
}

export function remarkIssueRefs({
  owner,
  repo,
  kinds,
}: {
  owner: string;
  repo: string;
  kinds?: ReadonlyMap<string, IssueRefKind>;
}) {
  // Which repo one match points at: the named one for `owner/repo#n`, the rendering repo
  // for a bare `#n`.
  function refTarget(m: RegExpExecArray): { owner: string; repo: string } {
    return m[1] ? { owner: m[1], repo: m[2] } : { owner, repo };
  }

  function refUrl(
    target: { owner: string; repo: string },
    num: string,
  ): string | null {
    const base = `/r/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
    const key = issueRefKey(`${target.owner}/${target.repo}`, Number(num));
    switch (kinds?.get(key)) {
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
      const url = refUrl(refTarget(m), m[3]);
      // A ref with no known kind is skipped rather than linked, so it stays part of the
      // surrounding text span.
      if (url) {
        if (m.index > last) {
          out.push({ type: "text", value: value.slice(last, m.index) });
        }
        out.push({
          type: "link",
          url,
          children: [{ type: "text", value: m[0] }],
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
