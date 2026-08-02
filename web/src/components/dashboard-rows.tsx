// Row renderers for the repo dashboard sections: issue rows and PR rows. Each
// links to its detail/list view and shows the v1-parity status badges
// (../lib/badges.ts).

import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Loader2, MessageSquare, Workflow } from "lucide-react";
import { useState } from "react";
import type { Issue, Label, PullRequest } from "@/api/types";
import { DiffStat } from "@/components/diff-stat";
import { OpenIssueHerdrButton } from "@/components/issue-herdr-section";
import { IssueWorkspaceChip } from "@/components/issue-workspace-chip";
import { LabelChip } from "@/components/label-chip";
import { LinkedPullSummaryRow } from "@/components/linked-pull-summary";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type Badge as BadgeData, pullBadges } from "@/lib/badges";
import { relativeTime } from "@/lib/time";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { useHoverPopover } from "@/lib/use-hover-popover";
import { cn } from "@/lib/utils";
import type { IssueListFilters } from "@/queries/issues";
import { useWorkflows } from "@/queries/workflows";

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
  workspaceFilter,
}: {
  labels: Label[];
  owner: string;
  repo: string;
  state?: IssueListFilters["state"];
  workspaceFilter?: string;
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
          workspaceFilter={workspaceFilter}
          className="shrink-0 whitespace-nowrap"
        />
      ))}
    </span>
  );
}

function IssueCommentCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span
      aria-label={`${count} ${count === 1 ? "comment" : "comments"}`}
      className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground/70 tabular-nums"
    >
      <MessageSquare aria-hidden="true" className="size-3" />
      {count}
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
        data-debug-component="IssuePopover"
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

// Compact "Start workflow" launcher shown when an issue has no active linked
// PR. It mirrors issue-detail's StartWorkflowControls (#1007) — same
// `terminal/launch` with the "workflow-run" workflow — but is sized down (h-6,
// text-xs, size-3 icons) to sit quietly at the linked-PR sub-row scale (text-xs)
// instead of reading as a primary action. With no saved workflows the menu
// links to Settings > Workflows, matching the detail control.
function StartWorkflowButton({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const { launchTerminal } = useTerminalLauncher();
  const navigate = useNavigate();
  const { data: workflows, isLoading } = useWorkflows();
  const [isLaunching, startLaunching] = useFixedLoading();
  const [menuOpen, setMenuOpen] = useState(false);

  function start(workflowId: number) {
    startLaunching();
    setMenuOpen(false);
    launchTerminal({
      repo: `${owner}/${repo}`,
      label: `Issue #${issue.number} - ${issue.title}`,
      workflow: "workflow-run",
      issueNumber: issue.number,
      workflowId,
    });
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          className="h-6 gap-1 px-2 text-xs font-normal"
          title="Start a saved workflow in auto mode (no approval prompts, no sandbox)"
          disabled={isLaunching || isLoading}
        >
          {isLaunching ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Workflow className="size-3" />
          )}
          Start workflow
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {workflows && workflows.length > 0 ? (
          workflows.map((wf) => (
            <DropdownMenuItem
              key={wf.id}
              className="flex-col items-start gap-1 px-3 py-3 whitespace-normal"
              onSelect={(event) => {
                event.preventDefault();
                start(wf.id);
              }}
            >
              <span className="w-full min-w-0 font-medium leading-tight">
                {wf.name}
              </span>
              {wf.description ? (
                <span className="line-clamp-3 w-full min-w-0 break-words text-xs leading-relaxed text-muted-foreground">
                  {wf.description}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              navigate({ to: "/settings/workflows" });
            }}
          >
            No saved workflows — set one up in Settings
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  labelWorkspaceFilter,
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
  /** Preserves the repo-top workspace filter when a label chip is clicked (#1494). */
  labelWorkspaceFilter?: string;
}) {
  const popover = useHoverPopover();
  // Usually 0–1 linked PRs; when more than one exists they stack vertically, one
  // sub-row each. Fall back to the singular field for any response shape that
  // only carries it.
  const pulls =
    issue.linked_pull_requests ??
    (issue.linked_pull_request ? [issue.linked_pull_request] : []);
  const canStartWorkflow =
    issue.state === "open" && issue.has_open_pull_request === false;
  return (
    <div
      data-debug-component="IssueRow"
      aria-label={`Issue #${issue.number}: ${issue.title}`}
      className="group flex flex-col gap-1 px-3 py-2 text-sm"
    >
      {issue.target_branch ? (
        <div className="flex justify-start">
          <IssueWorkspaceChip workspace={issue.target_branch} />
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <RepoChip label={repoLabel} owner={owner} repo={repo} />
        <Link
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
            workspaceFilter={labelWorkspaceFilter}
          />
        </div>
        {issue.state === "closed" ? <Badge tone="closed">closed</Badge> : null}
        {/* Fixed-width, right-aligned relative time keeps rows vertically aligned
            regardless of the relative-time length ("3m ago" vs "12h ago"). #278 */}
        <span className="w-16 shrink-0 truncate text-right text-xs text-muted-foreground">
          {relativeTime(showCreatedAt ? issue.created_at : issue.updated_at)}
        </span>
        <IssueCommentCount count={issue.comments} />
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
      {canStartWorkflow ? (
        // No active attempt: offer to start a workflow from the row, indented
        // to sit where the linked-PR sub-rows render (pl-7). This includes
        // issues whose previous attempts are all closed.
        <div className="pl-7">
          <StartWorkflowButton owner={owner} repo={repo} issue={issue} />
        </div>
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
      data-debug-component="PullRow"
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
