// Row renderers for the repo dashboard sections: issue rows and PR rows. Each
// links to its detail/list view and shows the v1-parity status badges
// (../lib/badges.ts).

import { Link } from "@tanstack/react-router";
import type { Issue, Label, PullRequest } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { issueBadges, pullBadges } from "@/lib/badges";
import { relativeTime } from "@/lib/time";

function RowBadges({ badges }: { badges: ReturnType<typeof issueBadges> }) {
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
  /** When set (cross-repo views), shows which project the issue belongs to. */
  repoLabel?: string;
  /**
   * Show the creation time instead of the last-update time. Used by lists that
   * are ordered newest-created first (the home "Recent issues" section), so the
   * visible timestamp matches the sort order.
   */
  showCreatedAt?: boolean;
}) {
  return (
    <Link
      to="/r/$owner/$repo/issues/$number"
      params={{ owner, repo, number: String(issue.number) }}
      className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
    >
      <RepoChip label={repoLabel} />
      <span className="shrink-0 text-muted-foreground">#{issue.number}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
      <RowLabels labels={issue.labels} />
      <RowBadges badges={issueBadges(issue)} />
      <span className="shrink-0 text-xs text-muted-foreground">
        {relativeTime(showCreatedAt ? issue.created_at : issue.updated_at)}
      </span>
    </Link>
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
      <RowBadges badges={pullBadges(pull)} />
      <span className="shrink-0 text-xs text-muted-foreground">
        {relativeTime(pull.updated_at)}
      </span>
    </Link>
  );
}
