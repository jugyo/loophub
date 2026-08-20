// Shared Markdown renderer for issue / PR / comment bodies. Bodies are persisted
// as plain Markdown source; we render them as GitHub Flavored Markdown here.
//
// XSS: react-markdown does not render raw HTML unless rehype-raw is added, which
// it is not. Any HTML embedded in a body is escaped and shown as literal text,
// so bodies cannot inject markup. Keep it that way — do not add rehype-raw.
//
// When `owner`/`repo` are provided, `#123` and `owner/repo#123` references in the body
// are linkified (see remarkIssueRefs); the custom `a` renderer turns those internal links
// into client-side router navigations. The references are classified first so each links
// straight to its canonical issue / pull route (#2362); a reference whose kind is unknown
// — the lookup is in flight, there is no such Issue/PR, or this hub does not host the repo
// it names — stays plain text.
//
// The rendered Markdown diff does not go through here: it draws one top-level block at a time
// (see markdown-diff-document.tsx) so a selection or an open composer re-renders one block
// instead of the whole document.

import { isValidElement, type ReactNode, useMemo } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  MarkdownImage,
  MarkdownLightboxProvider,
  MarkdownLink,
} from "@/components/markdown-elements";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import {
  type IssueRefKind,
  issueRefKey,
  issueRefTargets,
  remarkIssueRefs,
} from "@/lib/remark-issue-refs";
import { cn } from "@/lib/utils";
import { useIssueRefKinds } from "@/queries/issues";

// A ```mermaid fenced block renders as `<pre><code class="language-mermaid">...</code></pre>` by
// react-markdown's default (no `code` component is registered, so the `code` child is a plain
// React element, not yet rendered — its props are readable synchronously here). Extract the chart
// text when the `pre`'s only child is such a code element; otherwise this isn't a mermaid block.
function mermaidChart(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string; children?: unknown }>(child)) {
    return null;
  }
  if (child.type !== "code") return null;
  const className = child.props.className;
  if (
    typeof className !== "string" ||
    !/(^|\s)language-mermaid(\s|$)/.test(className)
  ) {
    return null;
  }
  const text = Array.isArray(child.props.children)
    ? child.props.children.join("")
    : child.props.children;
  return typeof text === "string" ? text.replace(/\n$/, "") : "";
}

// react-markdown treats the components map's entries as component types, so the map has to be a
// module-level constant: a map rebuilt per render remounts the whole document, which drops its
// scroll position.
const COMPONENTS: Components = {
  img({ src, alt, title }) {
    if (!src) return null;
    return <MarkdownImage src={src} alt={alt} title={title} />;
  },
  pre({ children, ...rest }) {
    const chart = mermaidChart(children);
    if (chart !== null) return <MermaidDiagram chart={chart} />;
    return <pre {...rest}>{children}</pre>;
  },
  a({ href, title, children }) {
    return (
      <MarkdownLink href={href} title={title}>
        {children}
      </MarkdownLink>
    );
  },
};

export function Markdown({
  children,
  className,
  owner,
  repo,
  typeset = false,
}: {
  children: string;
  className?: string;
  owner?: string;
  repo?: string;
  typeset?: boolean;
}) {
  const linkRefs = Boolean(owner && repo);
  const targets = useMemo(
    () => (linkRefs ? issueRefTargets(children, `${owner}/${repo}`) : []),
    [linkRefs, children, owner, repo],
  );
  const { data: refKinds } = useIssueRefKinds(targets);
  const kinds = useMemo(
    () =>
      new Map<string, IssueRefKind>(
        (refKinds ?? []).map((ref) => [
          issueRefKey(ref.repo, ref.number),
          ref.kind,
        ]),
      ),
    [refKinds],
  );
  const remarkPlugins: Options["remarkPlugins"] =
    owner && repo
      ? [remarkGfm, [remarkIssueRefs, { owner, repo, kinds }]]
      : [remarkGfm];
  return (
    <div className={cn(typeset ? "typeset" : "markdown-body", className)}>
      <MarkdownLightboxProvider>
        <ReactMarkdown remarkPlugins={remarkPlugins} components={COMPONENTS}>
          {children}
        </ReactMarkdown>
      </MarkdownLightboxProvider>
    </div>
  );
}
