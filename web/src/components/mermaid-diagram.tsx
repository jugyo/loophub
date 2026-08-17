// Renders a ```mermaid fenced code block from a Markdown body as an SVG diagram (see markdown.tsx).
// Clicking the diagram opens it full-size in <Lightbox>, matching the click-to-expand behavior of
// Markdown-embedded images (see image-lightbox.tsx).
//
// XSS: mermaid.render() is initialized with securityLevel "strict" (mermaid's own default), which
// sanitizes diagram text and rejects raw HTML/script in labels before producing SVG. That keeps this
// in line with markdown.tsx's policy of never rendering raw HTML from body content, even though the
// output below goes through dangerouslySetInnerHTML — the HTML string comes from mermaid's sanitized
// renderer, not from the user-supplied Markdown source directly. The lightbox re-injects the same
// already-sanitized SVG string (with its ids rewritten — see forLightbox — to avoid DOM id
// collisions with the inline copy), so it carries no additional XSS risk.
import {
  type CSSProperties,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Lightbox } from "@/components/lightbox";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";

let mermaidModulePromise: Promise<typeof import("mermaid").default> | null =
  null;

// Rewrites a mermaid SVG string so a second copy (the lightbox) can be mounted alongside the
// original without duplicate DOM ids — mermaid namespaces everything under the `renderId` passed
// to `mermaid.render()`: the root svg's own id, every marker/gradient/clipPath id, their
// `url(#...)`/`href="#..."` references, AND the CSS selectors in its embedded `<style>` block
// (mermaid scopes each rule with a literal `#<renderId>` prefix — see mermaid's own
// `compileCSS`/`createCssStyles`). A plain global substring replace of `renderId` therefore covers
// every occurrence, including inside that `<style>` text, which an attribute-only regex (matching
// just `id="..."`/`url(#...)`/`href="#..."`) would miss — leaving the `<style>` block's selectors
// pointing at the original (still-mounted) copy and the lightbox copy rendered unstyled.
// Trade-off: this also rewrites `renderId` if it happens to appear in rendered label text (diagram
// source is user-authored). `renderId` is a per-mount generated string, so a real collision is
// very unlikely, and the failure mode is cosmetic (a corrupted label in the lightbox copy only).
function forLightbox(svg: string, renderId: string): string {
  return svg.replaceAll(renderId, `${renderId}-lightbox`);
}

// The lightbox's enlarged copy of the diagram. Rendered imperatively (not via React's
// dangerouslySetInnerHTML) because it needs to post-process the injected SVG: give it unique ids
// (see forLightbox) and re-size the root <svg> so it actually renders bigger than its inline
// copy, instead of just being redisplayed at the same size.
//
// Mermaid's `useMaxWidth` sizing (see calculateSvgSizeAttrs in mermaid's source) writes
// `width="100%"` plus an inline `style="max-width: <diagram's own natural width>px"` on the root
// svg. Inline, that renders the diagram at `min(article width, its natural width)` — i.e. wide
// diagrams get visually squished down to fit the article column. Two things block simply
// clearing that inline style here: (1) it always wins over a stylesheet rule regardless of
// selector specificity, so a Tailwind class alone can't override it; (2) even once cleared, the
// remaining `width="100%"` still needs a definite containing block to resolve against, and this
// dialog's content box is auto-sized (flex "shrink to fit"), so `100%` resolves against the
// browser's UA-default replaced-element size instead of anything meaningful.
// Setting an explicit pixel `width` from the svg's own `viewBox` (its true natural size) sidesteps
// both: it gives the flex box a definite max-content size to shrink-fit against, and — combined
// with the `h-auto`/`max-w-full` classes below — lets the diagram render at its natural size, only
// scaled down (proportionally, via `height: auto`) if that's still bigger than the modal.
function ExpandedDiagram({ svg, renderId }: { svg: string; renderId: string }) {
  const ref = useRef<HTMLDivElement>(null);

  // useLayoutEffect (not useEffect): this div renders with no JSX children, so without
  // synchronous injection the browser would paint an empty box on open, then pop in the actual
  // (sized) diagram a frame later.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = forLightbox(svg, renderId);
    const svgEl = el.querySelector("svg");
    const viewBoxWidth = svgEl?.viewBox.baseVal.width;
    if (svgEl && viewBoxWidth) {
      svgEl.style.removeProperty("max-width");
      svgEl.style.width = `${viewBoxWidth}px`;
    }
  }, [svg, renderId]);

  return (
    <div
      ref={ref}
      data-debug-component="ExpandedDiagram"
      className="max-h-[90vh] max-w-[90vw] overflow-auto rounded bg-white p-6 shadow-2xl [&_svg]:h-auto [&_svg]:max-w-full"
    />
  );
}

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid")
      .then((mod) => {
        mod.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          // Without this, mermaid appends its own "bomb" error graphic straight to
          // document.body on a parse failure — outside this component's tree, and
          // impossible to clean up on unmount. We already show our own fallback below.
          suppressErrorRendering: true,
        });
        return mod.default;
      })
      .catch((err) => {
        // Don't cache a failed import (e.g. a transient network blip, or a stale chunk
        // after a redeploy) — otherwise every diagram in this tab stays broken until a
        // full page reload. Clear the cache so the next mount retries the import.
        mermaidModulePromise = null;
        throw err;
      });
  }
  return mermaidModulePromise;
}

export function MermaidDiagram({
  chart,
  className,
  style,
}: {
  chart: string;
  className?: string;
  style?: CSSProperties;
}) {
  // Mermaid needs a valid DOM id per diagram; useId() can contain colons, which mermaid rejects.
  const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    // A chart edit while the lightbox is open must not leave it open showing stale (or, once the
    // new render resolves, silently swapped-in) content the user never clicked to see.
    setExpanded(false);
    loadMermaid()
      .then((mermaid) => mermaid.render(renderId, chart))
      .then((result) => {
        if (!cancelled) setSvg(result.svg);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errorMessage(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, renderId]);

  if (svg) {
    const open = () => setExpanded(true);
    return (
      <>
        <div
          data-debug-component="MermaidDiagram"
          className={cn(
            "mermaid-diagram cursor-zoom-in overflow-x-auto",
            className,
          )}
          style={style}
          role="button"
          tabIndex={0}
          aria-label="Expand diagram"
          onClick={(e) => {
            // Mermaid renders `click nodeId "url"` directives as a real <a> around the node
            // (even under securityLevel "strict"); let that link navigate on its own instead of
            // also opening the lightbox on top of it.
            if ((e.target as Element).closest("a")) return;
            open();
          }}
          onKeyDown={(e) => {
            if (
              (e.key === "Enter" || e.key === " ") &&
              !(e.target as Element).closest("a")
            ) {
              e.preventDefault();
              open();
            }
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {expanded && (
          <Lightbox
            ariaLabel="Diagram preview"
            onClose={() => setExpanded(false)}
          >
            <ExpandedDiagram svg={svg} renderId={renderId} />
          </Lightbox>
        )}
      </>
    );
  }

  // Loading, or the diagram failed to parse/render: fall back to the plain source so the body
  // never renders blank or crashes the page.
  return (
    <div className={className} style={style}>
      {error && (
        <p className="mb-1 text-destructive text-sm">
          Failed to render Mermaid diagram: {error}
        </p>
      )}
      <pre>
        <code className="language-mermaid">{chart}</code>
      </pre>
    </div>
  );
}
