// Element renderers shared by the Markdown body renderer (markdown.tsx) and the block-wise
// rendered Markdown diff (markdown-diff-document.tsx), so both draw links and images the same way.

import { Link } from "@tanstack/react-router";
import {
  createContext,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ImageLightbox } from "@/components/image-lightbox";

// Matches the hrefs produced by remarkIssueRefs: /r/<owner>/<repo>/<segment>/<number>.
const REF_HREF = /^\/r\/([^/]+)\/([^/]+)\/(issues|pulls)\/(\d+)$/;

const REF_ROUTES = {
  issues: "/r/$owner/$repo/issues/$number",
  pulls: "/r/$owner/$repo/pulls/$number",
} as const;

const HTML_ATTACHMENT_HREF = /^\/attachments\/([0-9a-f]{64})$/;

const PREVIEW_CSP = [
  "default-src 'none'",
  "connect-src 'none'",
  "font-src data:",
  "img-src data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
].join("; ");

const PREVIEW_URL_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "formaction",
  "href",
  "poster",
  "src",
  "srcset",
]);

function sanitizePreviewHtml(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const element of document.querySelectorAll(
    "base, embed, form, frame, iframe, link, meta, object, portal, script, source, track",
  )) {
    element.remove();
  }
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        (PREVIEW_URL_ATTRIBUTES.has(name) &&
          !(
            name === "src" &&
            element.tagName.toLowerCase() === "img" &&
            attribute.value.startsWith("data:")
          ))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const csp = document.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", PREVIEW_CSP);
  document.head.prepend(csp);
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function textContent(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) return children.map(textContent).join("");
  if (isValidElement(children)) {
    return textContent(children.props.children);
  }
  return "";
}

function isHtmlAttachment(
  href: string | undefined,
  children: ReactNode,
): boolean {
  return (
    href !== undefined &&
    HTML_ATTACHMENT_HREF.test(href) &&
    /\.html?$/i.test(textContent(children).trim())
  );
}

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
  if (isHtmlAttachment(href, children)) {
    return (
      <span className="inline-flex items-center gap-2">
        <a href={href} title={title}>
          {children}
        </a>
        <HtmlAttachmentPreview
          href={`${href}/preview`}
          filename={textContent(children).trim()}
        />
      </span>
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

function HtmlAttachmentPreview({
  href,
  filename,
}: {
  href: string;
  filename: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("ready");
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const requestRef = useRef(0);

  const close = useCallback(() => {
    requestRef.current += 1;
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  async function openPreview() {
    const request = ++requestRef.current;
    setOpen(true);
    setStatus("loading");
    setSrcDoc(null);
    try {
      const response = await fetch(href, {
        credentials: "same-origin",
        headers: { accept: "text/html" },
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("text/html")
      ) {
        throw new Error("Preview unavailable");
      }
      const html = await response.text();
      if (request === requestRef.current) {
        setSrcDoc(sanitizePreviewHtml(html));
        setStatus("ready");
      }
    } catch {
      if (request === requestRef.current) setStatus("error");
    }
  }

  return (
    <>
      <button
        type="button"
        className="text-link text-sm hover:underline"
        onClick={() => void openPreview()}
      >
        プレビュー
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-label={`${filename} のプレビュー`}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div className="flex h-[85vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border bg-background shadow-lg">
              <div className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3">
                <h2 className="truncate font-medium">
                  {filename} のプレビュー
                </h2>
                <button
                  type="button"
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                  onClick={close}
                >
                  閉じる
                </button>
              </div>
              {status === "loading" && (
                <p className="p-6 text-sm text-muted-foreground" role="status">
                  プレビューを読み込んでいます…
                </p>
              )}
              {status === "error" && (
                <p className="p-6 text-sm text-destructive" role="alert">
                  {
                    "HTML プレビューを読み込めませんでした。添付ファイルをダウンロードして確認してください。"
                  }
                </p>
              )}
              {status === "ready" && srcDoc !== null && (
                <iframe
                  className="min-h-0 flex-1 bg-white"
                  srcDoc={srcDoc}
                  title={`${filename} のプレビュー内容`}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  onError={() => setStatus("error")}
                />
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
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
