// Element renderers shared by the Markdown body renderer (markdown.tsx) and the block-wise
// rendered Markdown diff (markdown-diff-document.tsx), so both draw links and images the same way.

import { Link } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useState,
} from "react";
import { ImageLightbox } from "@/components/image-lightbox";

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

export function MarkdownLink({
  href,
  title,
  children,
}: {
  href?: string;
  title?: string;
  children?: ReactNode;
}) {
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
}

// Clicking an embedded image opens it full-size in <ImageLightbox> (#471). The opener is handed
// down through a context so the components that render an image can stay module-level constants.
const OpenLightboxContext = createContext<
  ((src: string, alt: string) => void) | null
>(null);

export function MarkdownLightboxProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(
    null,
  );
  const open = useCallback(
    (src: string, alt: string) => setLightbox({ src, alt }),
    [],
  );
  return (
    <>
      <OpenLightboxContext.Provider value={open}>
        {children}
      </OpenLightboxContext.Provider>
      {lightbox && (
        <ImageLightbox
          key={lightbox.src}
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}

/** An embedded image that opens the lightbox on click or Enter/Space. */
export function MarkdownImage({
  src,
  alt,
  title,
}: {
  src: string;
  alt?: string;
  title?: string;
}) {
  const openLightbox = useContext(OpenLightboxContext);
  const open = () => openLightbox?.(src, alt ?? "");
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
}
