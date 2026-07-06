// Handoffs section for the PR detail (#352). Shows the orchestrator<->subagent handoffs recorded
// for a PR in chronological order (seq asc) — the durable record of the parent's instructions
// (direction "down") and the children's returns (direction "up"). It lives in the PR detail's
// sidebar next to Sessions (the AC's "Sessions の隣"), so a reader can follow a run's trajectory
// without it interrupting the main diff/review flow.
//
// Each row leads with the phase + a direction arrow (↓ instruction / ↑ return), the from→to roles,
// and an optional one-line summary. Expanding reveals the substance: the inline body (the
// instruction prompt or Verify report) rendered as Markdown, or — when the content's canonical copy
// lives elsewhere (plan=PR, diff=commit) — the `src` reference plus its content hash, which is what
// the hybrid storage keeps instead of a second copy. model/cost (when present) are shown as small
// observability footnotes. The whole section hides when a PR has no handoffs, so PRs developed
// without an orchestration loop stay uncluttered.

import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import type { Handoff } from "@/api/types";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/lib/badges";
import { relativeTime } from "@/lib/time";

// Phase → badge tone (reuses the existing palette; no new CSS). Unknown phases fall back to neutral.
const PHASE_TONE: Record<string, BadgeTone> = {
  plan: "open",
  code: "agent",
  verify: "review-passed",
  review: "unknown",
  fix: "conflict",
};

export function HandoffTimeline({
  owner,
  repo,
  handoffs,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  handoffs: Handoff[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  // Guarded against a non-array (the RPC mock returns {} for unstubbed methods) — otherwise `.map`
  // below throws instead of rendering empty.
  const list = Array.isArray(handoffs) ? handoffs : [];
  // Hide entirely until there is something to show (a PR with no orchestration loop stays clean).
  if (!isLoading && !isError && list.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Handoffs</h2>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading handoffs…
        </div>
      ) : isError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load handoffs.
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {list.map((h) => (
            <li key={h.id} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  #{h.seq}
                </span>
                <Badge tone={PHASE_TONE[h.phase] ?? "unknown"}>{h.phase}</Badge>
                {h.direction === "down" ? (
                  <ArrowDown
                    className="size-3.5 text-muted-foreground"
                    aria-label="instruction (down)"
                  />
                ) : (
                  <ArrowUp
                    className="size-3.5 text-muted-foreground"
                    aria-label="return (up)"
                  />
                )}
                {h.from || h.to ? (
                  <span className="text-xs text-muted-foreground">
                    {h.from ?? "?"} → {h.to ?? "?"}
                  </span>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {relativeTime(h.created_at)}
                </span>
              </div>
              {h.summary ? (
                <p className="mt-1 font-medium">{h.summary}</p>
              ) : null}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Details
                </summary>
                {h.body ? (
                  <Markdown owner={owner} repo={repo} className="mt-1">
                    {h.body}
                  </Markdown>
                ) : (
                  // No inline body → the substance lives in a canonical copy (plan=PR, diff=commit);
                  // show the reference + its content hash rather than duplicating the content.
                  <div className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                    {h.src ? (
                      <div>
                        ref:{" "}
                        <code className="rounded bg-muted px-1 py-0.5">
                          {h.src}
                        </code>
                      </div>
                    ) : null}
                    {h.hash ? (
                      <div>
                        hash:{" "}
                        <code className="rounded bg-muted px-1 py-0.5">
                          {h.hash.slice(0, 12)}
                        </code>
                      </div>
                    ) : null}
                  </div>
                )}
                {h.model || h.cost ? (
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    {h.model ? <span>model: {h.model}</span> : null}
                    {h.cost ? <span>cost: {h.cost}</span> : null}
                  </div>
                ) : null}
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
