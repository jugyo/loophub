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

import { Link } from "@tanstack/react-router";
import { isValidElement, type ReactNode, useMemo, useState } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageLightbox } from "@/components/image-lightbox";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import {
  type MarkdownRenderedBlock,
  type MarkdownRenderedBlockKind,
  markdownRenderedBlock,
} from "@/lib/markdown-source-map";
import {
  type IssueRefKind,
  issueRefKey,
  issueRefTargets,
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

function markdownComponents(
  onRenderedBlock?: (block: MarkdownRenderedBlock) => void,
  renderedBlockClassName?: (block: MarkdownRenderedBlock) => string | undefined,
): Components {
  const report = (
    kind: MarkdownRenderedBlockKind,
    node: Parameters<NonNullable<Components["p"]>>[0]["node"],
  ) => {
    const block = markdownRenderedBlock(kind, node);
    onRenderedBlock?.(block);
    return renderedBlockClassName?.(block);
  };

  return {
    p({ node, children, ...rest }) {
      return (
        <p {...rest} className={cn(rest.className, report("paragraph", node))}>
          {children}
        </p>
      );
    },
    h1({ node, children, ...rest }) {
      return (
        <h1 {...rest} className={cn(rest.className, report("heading", node))}>
          {children}
        </h1>
      );
    },
    h2({ node, children, ...rest }) {
      return (
        <h2 {...rest} className={cn(rest.className, report("heading", node))}>
          {children}
        </h2>
      );
    },
    h3({ node, children, ...rest }) {
      return (
        <h3 {...rest} className={cn(rest.className, report("heading", node))}>
          {children}
        </h3>
      );
    },
    h4({ node, children, ...rest }) {
      return (
        <h4 {...rest} className={cn(rest.className, report("heading", node))}>
          {children}
        </h4>
      );
    },
    h5({ node, children, ...rest }) {
      return (
        <h5 {...rest} className={cn(rest.className, report("heading", node))}>
          {children}
        </h5>
      );
    },
    h6({ node, children, ...rest }) {
      return (
        <h6 {...rest} className={cn(rest.className, report("heading", node))}>
          {children}
        </h6>
      );
    },
    li({ node, children, ...rest }) {
      return (
        <li {...rest} className={cn(rest.className, report("list-item", node))}>
          {children}
        </li>
      );
    },
    blockquote({ node, children, ...rest }) {
      return (
        <blockquote
          {...rest}
          className={cn(rest.className, report("blockquote", node))}
        >
          {children}
        </blockquote>
      );
    },
    tr({ node, children, ...rest }) {
      return (
        <tr {...rest} className={cn(rest.className, report("table-row", node))}>
          {children}
        </tr>
      );
    },
    img({ node, src, alt, title }) {
      const blockClassName = report("image", node);
      if (!src) return null;
      return (
        <img
          className={blockClassName}
          src={src}
          alt={alt ?? ""}
          title={title}
        />
      );
    },
    pre({ node, children, ...rest }) {
      const chart = mermaidChart(children);
      if (chart !== null) {
        return (
          <MermaidDiagram chart={chart} className={report("mermaid", node)} />
        );
      }
      return (
        <pre
          {...rest}
          className={cn(rest.className, report("code-block", node))}
        >
          {children}
        </pre>
      );
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
}

export function Markdown({
  children,
  className,
  owner,
  repo,
  typeset = false,
  onRenderedBlock,
  renderedBlockClassName,
}: {
  children: string;
  className?: string;
  owner?: string;
  repo?: string;
  typeset?: boolean;
  onRenderedBlock?: (block: MarkdownRenderedBlock) => void;
  renderedBlockClassName?: (block: MarkdownRenderedBlock) => string | undefined;
}) {
  // Clicking an embedded image opens it full-size in <ImageLightbox> (#471).
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
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
  const componentsWithImg: Components = {
    ...markdownComponents(onRenderedBlock, renderedBlockClassName),
    img({ node, src, alt, title }) {
      const block = markdownRenderedBlock("image", node);
      onRenderedBlock?.(block);
      if (!src) return null;
      const open = () => setLightbox({ src, alt: alt ?? "" });
      const image = (
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
      const blockClassName = renderedBlockClassName?.(block);
      return blockClassName ? (
        <span className={cn("markdown-diff-image-block", blockClassName)}>
          {image}
        </span>
      ) : (
        image
      );
    },
  };
  return (
    <div className={cn(typeset ? "typeset" : "markdown-body", className)}>
      <ReactMarkdown
        passNode
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
