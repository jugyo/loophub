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
import {
  Children,
  type CSSProperties,
  cloneElement,
  isValidElement,
  type ReactNode,
  useMemo,
  useState,
} from "react";
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
  renderedBlockStyle?: (
    block: MarkdownRenderedBlock,
  ) => CSSProperties | undefined,
  renderedBlockAction?: (block: MarkdownRenderedBlock) => ReactNode,
  renderedBlockAfter?: (block: MarkdownRenderedBlock) => ReactNode,
): Components {
  const report = (
    kind: MarkdownRenderedBlockKind,
    node: Parameters<NonNullable<Components["p"]>>[0]["node"],
  ) => {
    const block = markdownRenderedBlock(kind, node);
    onRenderedBlock?.(block);
    return renderedBlockClassName?.(block);
  };
  const action = (
    kind: MarkdownRenderedBlockKind,
    node: Parameters<NonNullable<Components["p"]>>[0]["node"],
  ) => renderedBlockAction?.(markdownRenderedBlock(kind, node));
  const style = (
    kind: MarkdownRenderedBlockKind,
    node: Parameters<NonNullable<Components["p"]>>[0]["node"],
  ) => renderedBlockStyle?.(markdownRenderedBlock(kind, node));
  const withAfter = (
    element: ReactNode,
    kind: MarkdownRenderedBlockKind,
    node: Parameters<NonNullable<Components["p"]>>[0]["node"],
  ) =>
    renderedBlockAfter ? (
      <>
        {element}
        {renderedBlockAfter(markdownRenderedBlock(kind, node))}
      </>
    ) : (
      element
    );

  return {
    p({ node, children, ...rest }) {
      return withAfter(
        <p
          {...rest}
          className={cn(rest.className, report("paragraph", node))}
          style={style("paragraph", node)}
        >
          {action("paragraph", node)}
          {children}
        </p>,
        "paragraph",
        node,
      );
    },
    h1({ node, children, ...rest }) {
      return withAfter(
        <h1
          {...rest}
          className={cn(rest.className, report("heading", node))}
          style={style("heading", node)}
        >
          {action("heading", node)}
          {children}
        </h1>,
        "heading",
        node,
      );
    },
    h2({ node, children, ...rest }) {
      return withAfter(
        <h2
          {...rest}
          className={cn(rest.className, report("heading", node))}
          style={style("heading", node)}
        >
          {action("heading", node)}
          {children}
        </h2>,
        "heading",
        node,
      );
    },
    h3({ node, children, ...rest }) {
      return withAfter(
        <h3
          {...rest}
          className={cn(rest.className, report("heading", node))}
          style={style("heading", node)}
        >
          {action("heading", node)}
          {children}
        </h3>,
        "heading",
        node,
      );
    },
    h4({ node, children, ...rest }) {
      return withAfter(
        <h4
          {...rest}
          className={cn(rest.className, report("heading", node))}
          style={style("heading", node)}
        >
          {action("heading", node)}
          {children}
        </h4>,
        "heading",
        node,
      );
    },
    h5({ node, children, ...rest }) {
      return withAfter(
        <h5
          {...rest}
          className={cn(rest.className, report("heading", node))}
          style={style("heading", node)}
        >
          {action("heading", node)}
          {children}
        </h5>,
        "heading",
        node,
      );
    },
    h6({ node, children, ...rest }) {
      return withAfter(
        <h6
          {...rest}
          className={cn(rest.className, report("heading", node))}
          style={style("heading", node)}
        >
          {action("heading", node)}
          {children}
        </h6>,
        "heading",
        node,
      );
    },
    li({ node, children, ...rest }) {
      return withAfter(
        <li
          {...rest}
          className={cn(rest.className, report("list-item", node))}
          style={style("list-item", node)}
        >
          {action("list-item", node)}
          {children}
        </li>,
        "list-item",
        node,
      );
    },
    ul({ node, children, ...rest }) {
      return withAfter(
        <ul
          {...rest}
          className={cn(rest.className, report("list", node))}
          style={style("list", node)}
        >
          {children}
        </ul>,
        "list",
        node,
      );
    },
    ol({ node, children, ...rest }) {
      return withAfter(
        <ol
          {...rest}
          className={cn(rest.className, report("list", node))}
          style={style("list", node)}
        >
          {children}
        </ol>,
        "list",
        node,
      );
    },
    blockquote({ node, children, ...rest }) {
      return withAfter(
        <blockquote
          {...rest}
          className={cn(rest.className, report("blockquote", node))}
          style={style("blockquote", node)}
        >
          {action("blockquote", node)}
          {children}
        </blockquote>,
        "blockquote",
        node,
      );
    },
    table({ node, children, ...rest }) {
      const blockClassName = report("table", node);
      const blockStyle = style("table", node);
      // A table cannot hold the block action itself — a span is not valid inside <table> — so the
      // action moves to a wrapper, which then carries the block's class and order as well.
      const blockAction = action("table", node);
      return withAfter(
        blockAction ? (
          <div
            className={cn("markdown-diff-table-block", blockClassName)}
            style={blockStyle}
          >
            {blockAction}
            <table {...rest}>{children}</table>
          </div>
        ) : (
          <table
            {...rest}
            className={cn(rest.className, blockClassName)}
            style={blockStyle}
          >
            {children}
          </table>
        ),
        "table",
        node,
      );
    },
    tr({ node, children, ...rest }) {
      const block = markdownRenderedBlock("table-row", node);
      const renderedAction = renderedBlockAction?.(block);
      const cells = Children.toArray(children);
      const lastCell = cells.at(-1);
      const rowChildren =
        renderedAction && isValidElement<{ children?: ReactNode }>(lastCell)
          ? [
              ...cells.slice(0, -1),
              cloneElement(
                lastCell,
                undefined,
                lastCell.props.children,
                renderedAction,
              ),
            ]
          : children;
      const row = (
        <tr
          {...rest}
          className={cn(rest.className, report("table-row", node))}
          style={style("table-row", node)}
        >
          {rowChildren}
        </tr>
      );
      const after = renderedBlockAfter?.(block);
      return after ? (
        <>
          {row}
          <tr>
            <td colSpan={100}>{after}</td>
          </tr>
        </>
      ) : (
        row
      );
    },
    img({ node, src, alt, title }) {
      const blockClassName = report("image", node);
      if (!src) return null;
      if (!renderedBlockAction) {
        const element = (
          <img
            className={blockClassName}
            style={style("image", node)}
            src={src}
            alt={alt ?? ""}
            title={title}
          />
        );
        return withAfter(element, "image", node);
      }
      return (
        <span
          className={cn(
            blockClassName,
            renderedBlockAction && "inline-flex items-center gap-1",
          )}
          style={style("image", node)}
        >
          {action("image", node)}
          <img src={src} alt={alt ?? ""} title={title} />
        </span>
      );
    },
    pre({ node, children, ...rest }) {
      const chart = mermaidChart(children);
      if (chart !== null) {
        const blockClassName = report("mermaid", node);
        const blockStyle = style("mermaid", node);
        const blockAction = action("mermaid", node);
        return withAfter(
          renderedBlockAction ? (
            <div
              className={cn(
                "markdown-mermaid-block flex items-start gap-1",
                blockClassName,
              )}
              style={blockStyle}
            >
              {blockAction}
              <MermaidDiagram chart={chart} className="min-w-0 flex-1" />
            </div>
          ) : (
            <MermaidDiagram
              chart={chart}
              className={blockClassName}
              style={blockStyle}
            />
          ),
          "mermaid",
          node,
        );
      }
      return withAfter(
        <pre
          {...rest}
          className={cn(rest.className, report("code-block", node))}
          style={style("code-block", node)}
        >
          {action("code-block", node)}
          {children}
        </pre>,
        "code-block",
        node,
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
  renderedBlockStyle,
  renderedBlockAction,
  renderedBlockAfter,
}: {
  children: string;
  className?: string;
  owner?: string;
  repo?: string;
  typeset?: boolean;
  onRenderedBlock?: (block: MarkdownRenderedBlock) => void;
  renderedBlockClassName?: (block: MarkdownRenderedBlock) => string | undefined;
  renderedBlockStyle?: (
    block: MarkdownRenderedBlock,
  ) => CSSProperties | undefined;
  renderedBlockAction?: (block: MarkdownRenderedBlock) => ReactNode;
  renderedBlockAfter?: (block: MarkdownRenderedBlock) => ReactNode;
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
    ...markdownComponents(
      onRenderedBlock,
      renderedBlockClassName,
      renderedBlockStyle,
      renderedBlockAction,
      renderedBlockAfter,
    ),
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
      const blockStyle = renderedBlockStyle?.(block);
      const after = renderedBlockAfter?.(block);
      if (!renderedBlockAction && !after) {
        return blockClassName || blockStyle ? (
          <img
            className={blockClassName}
            style={blockStyle}
            src={src}
            alt={alt ?? ""}
            title={title}
          />
        ) : (
          image
        );
      }
      const rendered = renderedBlockAction ? (
        blockClassName ? (
          <span
            className={cn("markdown-diff-image-block", blockClassName)}
            style={blockStyle}
          >
            {renderedBlockAction(block)}
            {image}
          </span>
        ) : (
          <span style={blockStyle}>
            {renderedBlockAction(block)}
            {image}
          </span>
        )
      ) : (
        image
      );
      return after ? (
        <>
          {rendered}
          {after}
        </>
      ) : (
        rendered
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
