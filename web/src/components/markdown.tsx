// Shared Markdown renderer for issue / PR / comment bodies. Bodies are persisted
// as plain Markdown source; we render them as GitHub Flavored Markdown here.
//
// XSS: react-markdown does not render raw HTML unless rehype-raw is added, which
// it is not. Any HTML embedded in a body is escaped and shown as literal text,
// so bodies cannot inject markup. Keep it that way — do not add rehype-raw.
//
// When `owner`/`repo` are provided, `#123` references in the body are linkified
// (see remarkIssueRefs); the custom `a` renderer turns those internal links into
// client-side router navigations. The referenced numbers are classified first so a
// reference links straight to its canonical issue / pull route (#2362); a number
// whose kind is unknown — the lookup is in flight, or there is no such Issue/PR —
// stays plain text.

import { Link } from "@tanstack/react-router";
import { isValidElement, type ReactNode, useMemo, useState } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageLightbox } from "@/components/image-lightbox";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import {
  type IssueRefKind,
  issueRefNumbers,
  remarkIssueRefs,
} from "@/lib/remark-issue-refs";
import { cn } from "@/lib/utils";
import { useIssueRefKinds } from "@/queries/issues";

// Matches the hrefs produced by remarkIssueRefs: /r/<owner>/<repo>/<segment>/<number>.
const REF_HREF = /^\/r\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)$/;

const REF_ROUTES = {
  issues: "/r/$owner/$repo/issues/$number",
  pulls: "/r/$owner/$repo/pulls/$number",
} as const;

// Decode the owner/repo captured from an internal ref href. A hand-authored
// body could contain a link that matches REF_HREF but has malformed percent
// encoding (e.g. `/r/%/y/issues/1`); decodeURIComponent would throw and tear
// down the whole render, so fall back to a plain anchor by returning null here.
function refParams(
  m: RegExpExecArray,
): { owner: string; repo: string; number: string } | null {
  try {
    return {
      owner: decodeURIComponent(m[1]),
      repo: decodeURIComponent(m[2]),
      number: m[4],
    };
  } catch {
    return null;
  }
}

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

const components: Components = {
  pre({ node, children, ...rest }) {
    const chart = mermaidChart(children);
    if (chart !== null) {
      return <MermaidDiagram chart={chart} />;
    }
    return <pre {...rest}>{children}</pre>;
  },
  a({ href, title, children }) {
    const m = href ? REF_HREF.exec(href) : null;
    const params = m ? refParams(m) : null;
    if (m && params) {
      return (
        <Link
          to={REF_ROUTES[m[3] as keyof typeof REF_ROUTES]}
          params={params}
          className="text-link hover:underline"
        >
          {children}
        </Link>
      );
    }
    // Preserve the link title (`[text](url "title")`); other anchor attributes
    // are not emitted by react-markdown for Markdown links.
    return (
      <a href={href} title={title}>
        {children}
      </a>
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
  // Clicking an embedded image opens it full-size in <ImageLightbox> (#471).
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const linkRefs = Boolean(owner && repo);
  const numbers = useMemo(
    () => (linkRefs ? issueRefNumbers(children) : []),
    [linkRefs, children],
  );
  const { data: refKinds } = useIssueRefKinds(owner ?? "", repo ?? "", numbers);
  const kinds = useMemo(
    () =>
      new Map<number, IssueRefKind>(
        (refKinds ?? []).map((ref) => [ref.number, ref.kind]),
      ),
    [refKinds],
  );
  const remarkPlugins: Options["remarkPlugins"] =
    owner && repo
      ? [remarkGfm, [remarkIssueRefs, { owner, repo, kinds }]]
      : [remarkGfm];
  const componentsWithImg: Components = {
    ...components,
    img({ src, alt, title }) {
      if (!src) return null;
      const open = () => setLightbox({ src, alt: alt ?? "" });
      return (
        <img
          src={src}
          alt={alt ?? ""}
          title={title}
          role="button"
          tabIndex={0}
          onClick={open}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open();
            }
          }}
        />
      );
    },
  };
  return (
    <div className={cn(typeset ? "typeset" : "markdown-body", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={componentsWithImg}
      >
        {children}
      </ReactMarkdown>
      {lightbox && (
        <ImageLightbox
          key={lightbox.src}
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
