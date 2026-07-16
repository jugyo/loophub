// Row renderers for the repo dashboard sections: issue rows and PR rows. Each
// links to its detail/list view and shows the v1-parity status badges
// (../lib/badges.ts).

import { Link } from "@tanstack/react-router";
import { Loader2, Play } from "lucide-react";
import type { Issue, Label, PullRequest } from "@/api/types";
import { DiffStat } from "@/components/diff-stat";
import { IssueBranchChip } from "@/components/issue-branch-chip";
import { OpenIssueHerdrButton } from "@/components/issue-herdr-section";
import { LabelChip } from "@/components/label-chip";
import { LinkedPullSummaryRow } from "@/components/linked-pull-summary";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Badge } from "@/components/ui/badge";
import { disabledIconButtonStateClasses } from "@/components/ui/button";
import {
  type Badge as BadgeData,
  issueBuildButtonState,
  pullBadges,
} from "@/lib/badges";
import { relativeTime } from "@/lib/time";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { useHoverPopover } from "@/lib/use-hover-popover";
import { cn } from "@/lib/utils";
import { useWebConfig } from "@/lib/web-config";
import type { IssueListFilters } from "@/queries/issues";

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
// dashboards where the project is already in context. Links to the repo
// dashboard when owner/repo are known (issue rows); falls back to a plain span
// otherwise (e.g. PR rows that don't thread owner/repo through).
function RepoChip({
  label,
  owner,
  repo,
}: {
  label?: string;
  owner?: string;
  repo?: string;
}) {
  if (!label) return null;
  const className =
    "shrink-0 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground";
  if (owner && repo) {
    return (
      <Link
        to="/r/$owner/$repo"
        params={{ owner, repo }}
        className={cn(className, "hover:underline")}
        title={label}
      >
        {label}
      </Link>
    );
  }
  return (
    <span className={className} title={label}>
      {label}
    </span>
  );
}

// Label chips, sharing the issue-detail chip style via LabelChip. Each chip
// links to the issues list filtered by that label (#368); colour is derived
// from the label name so the same label is always the same colour.
function RowLabels({
  labels,
  owner,
  repo,
  state,
}: {
  labels: Label[];
  owner: string;
  repo: string;
  state?: IssueListFilters["state"];
}) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {labels.map((l) => (
        <LabelChip
          key={l.name}
          name={l.name}
          owner={owner}
          repo={repo}
          state={state}
          className="shrink-0 whitespace-nowrap"
        />
      ))}
    </span>
  );
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function IssuePopover({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const paneId = issue.herdr_pane?.pane_id;
  const sessionName = issue.herdr_pane?.session_name ?? paneId ?? undefined;
  return (
    <div className="absolute left-0 top-full z-30 w-[420px] pt-1">
      <div
        role="dialog"
        aria-label={`Issue #${issue.number} details`}
        className="rounded-md border bg-background p-3 text-foreground shadow-lg"
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold">#{issue.number}</span>
          <Badge tone={issue.state}>{issue.state}</Badge>
          <span className="text-xs text-muted-foreground">
            @{issue.user.login}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {issue.comments} comment{issue.comments === 1 ? "" : "s"}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-xs">
          <div className="contents">
            <dt className="text-muted-foreground">Labels</dt>
            <dd className="flex min-w-0 flex-wrap gap-1">
              {issue.labels.length > 0
                ? issue.labels.map((label) => (
                    <Badge key={label.name}>{label.name}</Badge>
                  ))
                : "None"}
            </dd>
          </div>
          {issue.target_branch ? (
            <div className="contents">
              <dt className="text-muted-foreground">Target</dt>
              <dd className="min-w-0 truncate font-medium">
                {issue.target_branch}
              </dd>
            </div>
          ) : null}
          <div className="contents">
            <dt className="text-muted-foreground">Created</dt>
            <dd>
              <time dateTime={issue.created_at}>
                {timestamp(issue.created_at)}
              </time>
            </dd>
          </div>
          <div className="contents">
            <dt className="text-muted-foreground">Updated</dt>
            <dd>
              <time dateTime={issue.updated_at}>
                {timestamp(issue.updated_at)}
              </time>
            </dd>
          </div>
        </dl>
        <p className="mt-3 line-clamp-4 whitespace-pre-wrap break-words border-t pt-3 text-xs text-muted-foreground">
          {issue.body || "No description."}
        </p>
        {paneId ? (
          <div className="mt-3 flex items-center gap-2 border-t pt-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium" title={sessionName}>
                {sessionName}
              </div>
              <div className="text-xs text-muted-foreground">
                New Issue pane
              </div>
            </div>
            <OpenIssueHerdrButton
              owner={owner}
              repo={repo}
              paneId={paneId}
              className="h-8"
            />
          </div>
        ) : null}
      </div>
    </div>
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
  labelState,
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
  /** Preserves the active issue-list state when label chips filter the list. */
  labelState?: IssueListFilters["state"];
}) {
  const popover = useHoverPopover();
  // Usually 0–1 linked PRs; when more than one exists they stack vertically, one
  // sub-row each. Fall back to the singular field for any response shape that
  // only carries it.
  const pulls =
    issue.linked_pull_requests ??
    (issue.linked_pull_request ? [issue.linked_pull_request] : []);
  return (
    <div
      data-issue-row
      // Stable identity so keyboard selection can be restored when the list
      // re-appears after opening an issue and navigating back (#869).
      data-issue-key={`${owner}/${repo}#${issue.number}`}
      tabIndex={-1}
      aria-label={`Issue #${issue.number}: ${issue.title}`}
      className="group flex flex-col gap-1 px-3 py-2 text-sm focus:bg-accent focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring"
    >
      <div className="flex items-center gap-2">
        <RepoChip label={repoLabel} owner={owner} repo={repo} />
        <Link
          data-issue-row-link
          to="/r/$owner/$repo/issues/$number"
          params={{ owner, repo, number: String(issue.number) }}
          className="shrink-0 text-muted-foreground hover:underline"
        >
          #{issue.number}
        </Link>
        {/* Title + labels share one flex-1 group so the labels sit directly
            after the title (left-aligned), not pushed to the right edge. The
            group absorbs the slack, keeping the Build button / closed badge /
            relative time aligned on the right. #294 */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div
            className="relative min-w-0 shrink"
            onMouseLeave={popover.onMouseLeave}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                popover.close();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") popover.close();
            }}
          >
            <Link
              to="/r/$owner/$repo/issues/$number"
              params={{ owner, repo, number: String(issue.number) }}
              className="block truncate font-medium hover:underline"
              onMouseEnter={popover.onMouseEnter}
              onMouseLeave={popover.cancelPending}
              onFocus={popover.onFocus}
            >
              {issue.title}
            </Link>
            {popover.open ? (
              <IssuePopover owner={owner} repo={repo} issue={issue} />
            ) : null}
          </div>
          <RowLabels
            labels={issue.labels}
            owner={owner}
            repo={repo}
            state={labelState}
          />
          <IssueBranchChip
            branch={issue.target_branch}
            className="max-w-56 shrink-0 truncate"
          />
        </div>
        {issue.state === "closed" ? <Badge tone="closed">closed</Badge> : null}
        <RowBuildButton owner={owner} repo={repo} issue={issue} />
        {/* Fixed-width, right-aligned so the Build button to its left stays
            vertically aligned across rows regardless of the relative-time
            length ("3m ago" vs "12h ago"). #278 */}
        <span className="w-16 shrink-0 truncate text-right text-xs text-muted-foreground">
          {relativeTime(showCreatedAt ? issue.created_at : issue.updated_at)}
        </span>
      </div>
      {pulls.length > 0 ? (
        // Own column so the gap between stacked PRs is a touch wider than the
        // title↔first-PR gap above.
        <div className="flex flex-col gap-1.5">
          {pulls.map((pull) => (
            <LinkedPullSummaryRow
              key={pull.number}
              owner={owner}
              repo={repo}
              pull={pull}
              className="pl-7 pr-0"
              dimInactive
              popoverTrigger="pull-link"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Build button for an issue row: starts a build for the issue in a terminal, the
// same action as the issue-detail Build button (issue-detail.tsx). Always visible
// (not hover-revealed) so the row layout is stable regardless of label presence.
// Hidden (not replaced by a label — that's issue-detail.tsx only, by request)
// whenever the issue's primary linked PR is open or merged (issueBuildButtonState,
// #598) — a closed-unmerged (rejected) PR does NOT hide it, since the issue still
// needs a fresh attempt. Also hidden on a closed issue: no new work is started
// from a closed issue until it is reopened.
function RowBuildButton({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const { legacy } = useWebConfig();
  const { launchTerminal } = useTerminalLauncher();
  const [isLoading, startLoading] = useFixedLoading();
  const state = issueBuildButtonState(issue);
  if (legacy || issue.state !== "open" || state !== "build") return null;
  return (
    <button
      type="button"
      title={`Build issue #${issue.number} in a terminal`}
      aria-label={`Build issue #${issue.number}`}
      disabled={isLoading}
      onClick={() => {
        startLoading();
        launchTerminal({
          repo: `${owner}/${repo}`,
          label: `Issue #${issue.number} - ${issue.title}`,
          workflow: "issue-dev",
          issueNumber: issue.number,
        });
      }}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        disabledIconButtonStateClasses,
      )}
    >
      {isLoading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Play className="size-4" />
      )}
    </button>
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
