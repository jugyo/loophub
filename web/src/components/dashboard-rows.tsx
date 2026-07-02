// Row renderers for the repo dashboard sections: issue rows and PR rows. Each
// links to its detail/list view and shows the v1-parity status badges
// (../lib/badges.ts).

import { Link } from "@tanstack/react-router";
import { Check, Loader2, MoreHorizontal, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Issue, Label, LinkedPull, PullRequest } from "@/api/types";
import { DiffStat } from "@/components/diff-stat";
import { LabelChip } from "@/components/label-chip";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Badge, badgeVariants } from "@/components/ui/badge";
import {
  type Badge as BadgeData,
  linkedPullPillTone,
  linkedPullStatus,
  linkedPullWordTone,
  pullBadges,
  type StatusWordTone,
} from "@/lib/badges";
import { relativeTime } from "@/lib/time";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { cn } from "@/lib/utils";
import { useSetIssueState } from "@/queries/issues";
import { useSettings } from "@/queries/settings";

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
}: {
  labels: Label[];
  owner: string;
  repo: string;
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
    <div className="group flex flex-col gap-1 px-3 py-2 text-sm hover:bg-accent">
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
          <Link
            to="/r/$owner/$repo/issues/$number"
            params={{ owner, repo, number: String(issue.number) }}
            className="min-w-0 truncate font-medium hover:underline"
          >
            {issue.title}
          </Link>
          <RowLabels labels={issue.labels} owner={owner} repo={repo} />
        </div>
        {issue.state === "closed" ? <Badge tone="closed">closed</Badge> : null}
        <RowBuildButton owner={owner} repo={repo} issue={issue} pulls={pulls} />
        {/* Fixed-width, right-aligned so the Build button to its left stays
            vertically aligned across rows regardless of the relative-time
            length ("3m ago" vs "12h ago"). #278 */}
        <span className="w-16 shrink-0 truncate text-right text-xs text-muted-foreground">
          {relativeTime(showCreatedAt ? issue.created_at : issue.updated_at)}
        </span>
        <IssueRowMenu owner={owner} repo={repo} issue={issue} />
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

// Build button for an issue row: starts `lh dev <n>` in a terminal, the same
// action as the issue-detail Build button (issue-detail.tsx). Always visible
// (not hover-revealed) so the row layout is stable regardless of label presence.
// Hidden whenever a linked PR is actively in progress (open) or already merged
// (done) — mirroring `activePull` there; a closed-unmerged (rejected) PR does
// NOT hide it, since the issue still needs a fresh attempt.
function RowBuildButton({
  owner,
  repo,
  issue,
  pulls,
}: {
  owner: string;
  repo: string;
  issue: Issue;
  pulls: LinkedPull[];
}) {
  const { launchTerminal } = useTerminalLauncher();
  const { data: settings } = useSettings();
  const [isLoading, startLoading] = useFixedLoading();
  const activePull = pulls.some((p) => p.state === "open" || p.merged);
  if (activePull) return null;
  const command = settings?.autoModeOnBuild
    ? `lh dev ${issue.number} --auto`
    : `lh dev ${issue.number}`;
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
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
    >
      {isLoading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Play className="size-4" />
      )}
    </button>
  );
}

// Overflow (⋮) menu for an issue row: currently a single Close/Reopen action,
// reusing the same toggle mutation as the issue-detail Close/Reopen button
// (issue-detail.tsx). Hand-rolled dropdown (no Radix dependency in this
// project) matching the PullDebugMenu pattern (pull-debug-menu.tsx): outside
// click / Escape closes the menu. Always visible, like RowBuildButton, so the
// row layout doesn't shift on hover.
function IssueRowMenu({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const setState = useSetIssueState(owner, repo, issue.number);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const label = issue.state === "open" ? "Close" : "Reopen";

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Issue #${issue.number} actions`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <MoreHorizontal className="size-4" />
      </button>

      {menuOpen ? (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 min-w-28 rounded-md border bg-background p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            disabled={setState.isPending}
            onClick={() => {
              setMenuOpen(false);
              setState.mutate(issue.state === "open" ? "closed" : "open");
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-60"
          >
            {label}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Tailwind text colour per status-word tone (linkedPullWordTone) — the
// state-specific axis of the linked-PR sub-row, independent of the pill's
// lifecycle colour. Only danger / ready / done carry a signal colour; muted is
// the default so the few coloured words stand out.
const STATUS_TEXT: Record<StatusWordTone, string> = {
  danger: "text-destructive",
  ready: "text-green-600 dark:text-green-400",
  done: "text-purple-500 dark:text-purple-400",
  muted: "text-muted-foreground",
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
  // Two independent colour axes: the pill carries the PR lifecycle (open=green /
  // merged=purple / closed=grey), the status word its state-specific signal
  // (STATUS_TEXT). A muted pill when status is null (issue-detail summary path).
  const pillTone = status ? linkedPullPillTone(pull) : "unknown";
  // pass 済みなら、緑にまとめられた未マージ群の中から一目で識別できるよう
  // ステータス語にチェックアイコンを添える。他の未マージ状態には出さない。
  const passed = status?.tone === "review-passed";
  const files = pull.changed_files ?? 0;
  return (
    <div className="flex items-center gap-2 pl-7 text-xs text-muted-foreground">
      <Link
        to="/r/$owner/$repo/pulls/$number"
        params={{ owner, repo, number: String(pull.number) }}
        className={cn(
          badgeVariants({ tone: pillTone }),
          "shrink-0 hover:opacity-80",
        )}
      >
        PR #{pull.number}
      </Link>
      {status ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-0.5 font-medium",
            STATUS_TEXT[linkedPullWordTone(status.tone)],
          )}
          title={status.title}
        >
          {passed ? (
            <Check
              className="size-3.5 text-green-600 dark:text-green-400"
              aria-label="passed"
            />
          ) : null}
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
