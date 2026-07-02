// Renders a ```mermaid fenced code block from a Markdown body as an SVG diagram (see markdown.tsx).
//
// XSS: mermaid.render() is initialized with securityLevel "strict" (mermaid's own default), which
// sanitizes diagram text and rejects raw HTML/script in labels before producing SVG. That keeps this
// in line with markdown.tsx's policy of never rendering raw HTML from body content, even though the
// output below goes through dangerouslySetInnerHTML — the HTML string comes from mermaid's sanitized
// renderer, not from the user-supplied Markdown source directly.
import { useEffect, useId, useState } from "react";

let mermaidModulePromise: Promise<typeof import("mermaid").default> | null =
  null;

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

export function MermaidDiagram({ chart }: { chart: string }) {
  // Mermaid needs a valid DOM id per diagram; useId() can contain colons, which mermaid rejects.
  const renderId = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    loadMermaid()
      .then((mermaid) => mermaid.render(renderId, chart))
      .then((result) => {
        if (!cancelled) setSvg(result.svg);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chart, renderId]);

  if (svg) {
    return (
      <div
        className="mermaid-diagram overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  // Loading, or the diagram failed to parse/render: fall back to the plain source so the body
  // never renders blank or crashes the page.
  return (
    <div>
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
