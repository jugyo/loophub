// GitHub PR status section for the PR-detail right sidebar (#850). Shown only when the loophub PR has
// a linked GitHub PR (github_pull); the GitHub-side status (review / checks / comment counts /
// merged) is fetched on demand via `pulls/githubStatus` and cached server-side. Compact by design so
// it sits alongside the other sidebar sections (work duration, sessions, handoff) without crowding
// them — a badge row plus a few small labeled rows and a freshness footnote. The section body opens
// with the link out to the GitHub PR (#2091), so the GitHub route lives where the status is read;
// the heading itself is plain text.
//
// Loading / error states mirror the sibling sidebar sections (e.g. WorkDuration): a spinner while
// fetching and a destructive box on failure. The "not linked" state is handled by the caller — the
// section is not rendered at all when github_pull is absent.

import { ExternalLink, Github, Loader2 } from "lucide-react";
import type { GithubPrStatus, GithubPull } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/lib/badges";
import { relativeTime } from "@/lib/time";

const STATE: Record<
  GithubPrStatus["state"],
  { tone: BadgeTone; label: string }
> = {
  open: { tone: "open", label: "Open" },
  closed: { tone: "closed", label: "Closed" },
  merged: { tone: "merged", label: "Merged" },
};

const REVIEW: Record<
  NonNullable<GithubPrStatus["review_decision"]>,
  { tone: BadgeTone; label: string }
> = {
  approved: { tone: "review-passed", label: "Approved" },
  changes_requested: { tone: "review-changes", label: "Changes requested" },
  review_required: { tone: "review-rereview", label: "Review required" },
};

const CHECKS: Record<
  GithubPrStatus["checks"],
  { tone: BadgeTone; label: string } | null
> = {
  success: { tone: "review-passed", label: "Passed" },
  failure: { tone: "conflict", label: "Failing" },
  pending: { tone: "working", label: "Pending" },
  // No checks configured on the GitHub PR — the row is hidden rather than showing a meaningless badge.
  none: null,
};

const MERGEABLE: Record<
  GithubPrStatus["mergeable"],
  { tone: BadgeTone; label: string } | null
> = {
  mergeable: { tone: "mergeable", label: "No conflicts" },
  conflicting: { tone: "conflict", label: "Conflicts" },
  // Unknown (e.g. a merged/closed PR, or GitHub still computing) — hidden to keep the panel compact.
  unknown: null,
};

/**
 * The GitHub PR link's text: the stored URL minus its scheme and host, e.g. `me/proj/pull/42`. Kept
 * as a plain strip rather than a parse into owner/repo/number, so a URL that doesn't have the shape
 * we expect still reads as itself instead of throwing or being reduced to a bare number.
 */
function githubPrPath(url: string) {
  return url.replace(/^https?:\/\/[^/]+\//, "");
}

/** One `label + badge` row; renders nothing when the badge is absent (keeps the panel compact). */
function StatusRow({
  label,
  badge,
}: {
  label: string;
  badge: { tone: BadgeTone; label: string } | null;
}) {
  if (!badge) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </div>
  );
}

export function GithubPrStatusSection({
  githubPull,
  status,
  isLoading,
}: {
  // The linked GitHub PR itself (#2035): the body's first row is the single link out to GitHub, so
  // the PR-detail action row doesn't need a separate "View PR on GitHub" button. Non-null because
  // the caller only renders the section for a linked PR.
  githubPull: GithubPull;
  status: GithubPrStatus | undefined;
  isLoading: boolean;
  // isError is intentionally not a prop: the section only renders for a linked GitHub PR (an enabled
  // query), so the states are exhaustive — loading, a status to show, or (no status, not loading) an
  // error. A failed background refetch keeps `status`, so it stays on the data branch. See the JSX.
}) {
  return (
    <section
      data-debug-component="GithubPrStatusSection"
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">GitHub PR</h2>
      {/* The route out to GitHub (#2091). Outside the status branches below because it is the PR
          detail's only link to the GitHub PR, so it must stay reachable while the status is loading
          or failed. The text is the URL's own `owner/repo/pull/N` path rather than a bare `#N`: it
          says which GitHub repo the PR lives in, which a fork or a mirror makes non-obvious. */}
      <a
        href={githubPull.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`GitHub PR #${githubPull.number}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm hover:underline"
      >
        <Github className="size-4 shrink-0" />
        <span className="min-w-0 break-all">
          {githubPrPath(githubPull.url)}
        </span>
        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
      </a>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading GitHub status…
        </div>
      ) : /* Prefer the last-loaded status over the error box: React Query keeps `data` on a failed
            background refetch, so a transient blip (server restart, focus refetch) shouldn't blank a
            good panel. The error box shows only when there is no status to fall back to. */
      status ? (
        <div className="flex flex-col gap-2">
          {/* Top line: overall GitHub PR state. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATE[status.state].tone}>
              {STATE[status.state].label}
            </Badge>
          </div>
          <StatusRow
            label="Review"
            badge={
              status.review_decision
                ? REVIEW[status.review_decision]
                : { tone: "unknown", label: "None" }
            }
          />
          <StatusRow label="Checks" badge={CHECKS[status.checks]} />
          <StatusRow label="Mergeable" badge={MERGEABLE[status.mergeable]} />
          {/* Two distinct counts, labeled so neither is mistaken for the other (#850 AC): conversation
              comments vs submitted reviews. */}
          <p className="text-xs text-muted-foreground">
            {status.comments} comment{status.comments === 1 ? "" : "s"} ·{" "}
            {status.reviews} review{status.reviews === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-muted-foreground">
            {status.updated_at
              ? `Updated ${relativeTime(status.updated_at)} · `
              : ""}
            synced {relativeTime(status.synced_at)}
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load GitHub status.
        </div>
      )}
    </section>
  );
}
