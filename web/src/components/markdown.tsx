// Shared Markdown renderer for issue / PR / comment bodies. Bodies are persisted
// as plain Markdown source; we render them as GitHub Flavored Markdown here.
//
// XSS: react-markdown does not render raw HTML unless rehype-raw is added, which
// it is not. Any HTML embedded in a body is escaped and shown as literal text,
// so bodies cannot inject markup. Keep it that way — do not add rehype-raw.
//
// When `owner`/`repo` are provided, `#123` references in the body are linkified
// to the in-repo resolver route (see remarkIssueRefs); the custom `a` renderer
// turns those internal links into client-side router navigations.

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageLightbox } from "@/components/image-lightbox";
import { remarkIssueRefs } from "@/lib/remark-issue-refs";
import { cn } from "@/lib/utils";

// Matches the hrefs produced by remarkIssueRefs: /r/<owner>/<repo>/n/<number>.
const REF_HREF = /^\/r\/([^/]+)\/([^/]+)\/n\/(\d+)$/;

// Decode the owner/repo captured from an internal ref href. A hand-authored
// body could contain a link that matches REF_HREF but has malformed percent
// encoding (e.g. `/r/%/y/n/1`); decodeURIComponent would throw and tear down
// the whole render, so fall back to a plain anchor by returning null here.
function refParams(
  m: RegExpExecArray,
): { owner: string; repo: string; number: string } | null {
  try {
    return {
      owner: decodeURIComponent(m[1]),
      repo: decodeURIComponent(m[2]),
      number: m[3],
    };
  } catch {
    return null;
  }
}

const components: Components = {
  a({ href, title, children }) {
    const m = href ? REF_HREF.exec(href) : null;
    const params = m ? refParams(m) : null;
    if (params) {
      return (
        <Link
          to="/r/$owner/$repo/n/$number"
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
}: {
  children: string;
  className?: string;
  owner?: string;
  repo?: string;
}) {
  // Clicking an embedded image opens it full-size in <ImageLightbox> (#471).
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const remarkPlugins: Options["remarkPlugins"] =
    owner && repo
      ? [remarkGfm, [remarkIssueRefs, { owner, repo }]]
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
    <div className={cn("markdown-body", className)}>
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
