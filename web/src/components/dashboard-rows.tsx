// Row renderers for the repo dashboard sections: issue rows and PR rows. Each
// links to its detail/list view and shows the v1-parity status badges
// (../lib/badges.ts).

import { Link } from "@tanstack/react-router";
import type { Issue, Label, LinkedPull, PullRequest } from "@/api/types";
import { DiffStat } from "@/components/diff-stat";
import { Badge, badgeVariants } from "@/components/ui/badge";
import {
  type Badge as BadgeData,
  type BadgeTone,
  linkedPullDisplayTone,
  linkedPullStatus,
  pullBadges,
} from "@/lib/badges";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

function RowBadges({ badges }: { badges: BadgeData[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {badges.map((b, i) => (
        <Badge key={`${b.tone}-${i}`} tone={b.tone} title={b.title}>
          {b.label}
        </Badge>
      ))}
    </span>
  );
}

// Repo identity chip for cross-repo rows (top page). Omitted on per-repo
// dashboards where the project is already in context.
function RepoChip({ label }: { label?: string }) {
  if (!label) return null;
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
      title={label}
    >
      {label}
    </span>
  );
}

// Label chips, sharing the issue-detail chip style (issue-detail.tsx).
function RowLabels({ labels }: { labels: Label[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {labels.map((l) => (
        <span
          key={l.name}
          className="shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {l.name}
        </span>
      ))}
    </span>
  );
}

// Single issue list row, shared by every issue list (home "Recent issues",
// repo dashboard "Open Issues", and the dedicated /issues page). Pattern E
// (#194): the title is the issue link — so a linked PR can render as its own
// link pill on a muted sub-row below — and the whole row is not a single link.
// The redundant `open` badge is dropped (these lists are open-only; only
// `closed`, surfaced under the closed filter, carries signal).
export function IssueRow({
  owner,
  repo,
  issue,
  repoLabel,
  showCreatedAt = false,
}: {
  owner: string;
  repo: string;
  issue: Issue;
  /** When set (cross-repo views, e.g. home), shows which project the issue belongs to. */
  repoLabel?: string;
  /**
   * Show the creation time instead of the last-update time. Used by lists that
   * are ordered newest-created first (the home "Recent issues" section), so the
   * visible timestamp matches the sort order.
   */
  showCreatedAt?: boolean;
}) {
  // Usually 0–1 linked PRs; when more than one exists they stack vertically, one
  // sub-row each. Fall back to the singular field for any response shape that
  // only carries it.
  const pulls =
    issue.linked_pull_requests ??
    (issue.linked_pull_request ? [issue.linked_pull_request] : []);
  return (
    <div className="flex flex-col gap-1 px-3 py-2 text-sm hover:bg-accent">
      <div className="flex items-center gap-2">
        <RepoChip label={repoLabel} />
        <span className="shrink-0 text-muted-foreground">#{issue.number}</span>
        <Link
          to="/r/$owner/$repo/issues/$number"
          params={{ owner, repo, number: String(issue.number) }}
          className="min-w-0 flex-1 truncate font-medium hover:underline"
        >
          {issue.title}
        </Link>
        <RowLabels labels={issue.labels} />
        {issue.state === "closed" ? <Badge tone="closed">closed</Badge> : null}
        <span className="shrink-0 text-xs text-muted-foreground">
          {relativeTime(showCreatedAt ? issue.created_at : issue.updated_at)}
        </span>
      </div>
      {pulls.length > 0 ? (
        // Own column so the gap between stacked PRs is a touch wider than the
        // title↔first-PR gap above.
        <div className="flex flex-col gap-1.5">
          {pulls.map((pull) => (
            <LinkedPullSubRow
              key={pull.number}
              owner={owner}
              repo={repo}
              pull={pull}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Status-word color per (collapsed) tone for the linked-PR sub-row. The PR pill
// carries the same collapsed tone via badgeVariants; the word repeats it as
// plain text so the status reads without relying on the pill border alone. The
// sub-row uses only the three #244 colors — green (unmerged), purple (merged),
// muted (working / closed) — so this maps only the tones linkedPullDisplayTone
// produces.
const STATUS_TEXT: Partial<Record<BadgeTone, string>> = {
  open: "text-green-600 dark:text-green-400",
  merged: "text-purple-500 dark:text-purple-400",
  unknown: "text-muted-foreground",
};

// Muted sub-row under an issue title carrying its linked PR: a toned `PR #n`
// link pill, the single status word, and the diff total. Its own PR link (not
// the issue title link), so the row exposes two distinct destinations.
function LinkedPullSubRow({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
}) {
  const status = linkedPullStatus(pull);
  const tone = status ? linkedPullDisplayTone(status.tone) : "unknown";
  const files = pull.changed_files ?? 0;
  return (
    <div className="flex items-center gap-2 pl-7 text-xs text-muted-foreground">
      <Link
        to="/r/$owner/$repo/pulls/$number"
        params={{ owner, repo, number: String(pull.number) }}
        className={cn(badgeVariants({ tone }), "shrink-0 hover:opacity-80")}
      >
        PR #{pull.number}
      </Link>
      {status ? (
        <span
          className={cn("shrink-0 font-medium", STATUS_TEXT[tone])}
          title={status.title}
        >
          {status.label}
        </span>
      ) : null}
      {files > 0 ? (
        <DiffStat
          additions={pull.additions ?? 0}
          deletions={pull.deletions ?? 0}
        />
      ) : null}
    </div>
  );
}

export function PullRow({
  owner,
  repo,
  pull,
  repoLabel,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
  /** When set (cross-repo views), shows which project the PR belongs to. */
  repoLabel?: string;
}) {
  return (
    <Link
      to="/r/$owner/$repo/pulls/$number"
      params={{ owner, repo, number: String(pull.number) }}
      className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
    >
      <RepoChip label={repoLabel} />
      <span className="shrink-0 text-muted-foreground">#{pull.number}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{pull.title}</span>
      {pull.changed_files > 0 ? (
        <DiffStat
          additions={pull.additions}
          deletions={pull.deletions}
          className="shrink-0 text-xs"
        />
      ) : null}
      <RowBadges badges={pullBadges(pull)} />
      <span className="shrink-0 text-xs text-muted-foreground">
        {relativeTime(pull.updated_at)}
      </span>
    </Link>
  );
}
