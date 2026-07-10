// Row renderers for the repo dashboard sections: issue rows and PR rows. Each
// links to its detail/list view and shows the v1-parity status badges
// (../lib/badges.ts).

import { Link } from "@tanstack/react-router";
import { Loader2, Play } from "lucide-react";
import type { Issue, Label, PullRequest } from "@/api/types";
import { DiffStat } from "@/components/diff-stat";
import { isPullHerdrWorking } from "@/components/herdr-badge";
import { IssueBranchChip } from "@/components/issue-branch-chip";
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
import { cn } from "@/lib/utils";
import type { IssueListFilters } from "@/queries/issues";
import { useSettings } from "@/queries/settings";
import { useHerdrSessions } from "@/queries/terminal";

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
      className="group flex flex-col gap-1 px-3 py-2 text-sm hover:bg-accent focus:bg-accent focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring"
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
          <Link
            to="/r/$owner/$repo/issues/$number"
            params={{ owner, repo, number: String(issue.number) }}
            className="min-w-0 truncate font-medium hover:underline"
          >
            {issue.title}
          </Link>
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
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Build button for an issue row: starts `lh build <n>` in a terminal, the same
// action as the issue-detail Build button (issue-detail.tsx). Always visible
// (not hover-revealed) so the row layout is stable regardless of label presence.
// Hidden (not replaced by a label — that's issue-detail.tsx only, by request)
// whenever the issue's primary linked PR is open or merged (issueBuildButtonState,
// #598) — a closed-unmerged (rejected) PR does NOT hide it, since the issue still
// needs a fresh attempt.
function RowBuildButton({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const { launchTerminal } = useTerminalLauncher();
  const { data: settings } = useSettings();
  const [isLoading, startLoading] = useFixedLoading();
  const state = issueBuildButtonState(issue);
  if (state !== "build") return null;
  // Display-only: the herdr backend builds and spawns `lh build <n> --herdr [--auto]` itself
  // (core/service.ts's launchIssueDevHerdr, #584) — this string is never sent over the wire, it
  // only drives the button's tooltip so it reflects what actually runs. The Build button doesn't
  // pick a runtime itself, so it inherits whichever agent `lh build` resolves to (#593).
  const autoModeOnBuild = settings
    ? settings.agents[settings.codingAgent]?.autoModeOnBuild
    : false;
  const command = autoModeOnBuild
    ? `lh build ${issue.number} --herdr --auto`
    : `lh build ${issue.number} --herdr`;
  return (
    <button
      type="button"
      title={`Start \`${command}\` in a terminal`}
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
  const { data: herdrSessions } = useHerdrSessions();
  const agentWorking = isPullHerdrWorking(
    herdrSessions,
    `${owner}/${repo}`,
    pull.number,
  );
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
      <RowBadges badges={pullBadges(pull, { agentWorking })} />
      <span className="shrink-0 text-xs text-muted-foreground">
        {relativeTime(pull.updated_at)}
      </span>
    </Link>
  );
}
