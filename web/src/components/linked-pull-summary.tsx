import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Bot,
  Check,
  Loader2,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import type { LinkedPull } from "@/api/types";
import { DiffStat } from "@/components/diff-stat";
import { HerdrAgentInput } from "@/components/herdr-agent-input";
import {
  findPullHerdrWorkspace,
  isPullHerdrWorking,
} from "@/components/herdr-badge";
import { LinkedGithubPrBadge } from "@/components/linked-github-pr-badge";
import { useToast } from "@/components/toast";
import { Button, buttonVariants } from "@/components/ui/button";
import { CODING_AGENT_LABELS } from "@/lib/agent-models";
import {
  costStoppedBadge,
  linkedPullStateBadge,
  linkedPullStatus,
  linkedPullWordTone,
  type StatusWordTone,
} from "@/lib/badges";
import {
  formatCost,
  formatTokenCount,
  formatTokenCountShort,
} from "@/lib/session-usage";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useSetPullState } from "@/queries/pulls";
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";

const STATUS_TEXT: Record<StatusWordTone, string> = {
  danger: "text-destructive",
  ready: "text-green-600 dark:text-green-400",
  done: "text-violet-500 dark:text-violet-400",
  muted: "text-muted-foreground",
};

const COST_STOPPED_TEXT = "text-amber-700 dark:text-amber-300";

const WORK_BASIS_LABEL: Record<
  NonNullable<LinkedPull["work_duration_total"]>["basis"],
  string
> = {
  merged: "merged",
  closed: "closed",
  in_review: "in review",
  in_progress: "in progress",
};

function agentRuntimeLabel(runtime: string): string {
  if (runtime === "claude-code" || runtime === "codex") {
    return CODING_AGENT_LABELS[runtime];
  }
  return runtime;
}

function agentRuntimeMetadataLabel(runtime?: string, model?: string): string {
  const parts = [
    runtime ? agentRuntimeLabel(runtime) : null,
    model?.trim() || null,
  ].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(" · ") : "Agent";
}

function formatCostRounded(costUsd?: number | null): string | null {
  if (costUsd == null || !Number.isFinite(costUsd)) return null;
  return `$${Math.round(costUsd).toLocaleString()}`;
}

function formatDurationLargest(seconds?: number): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const units: Array<[number, string]> = [
    [31536000, "y"],
    [2592000, "mo"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
  ];
  const [unit, suffix] = units.find(
    ([unitSeconds]) => total >= unitSeconds,
  ) ?? [1, "s"];
  return `${Math.floor(total / unit)}${suffix}`;
}

function Metrics({
  pull,
  overBudget,
}: {
  pull: LinkedPull;
  overBudget: boolean;
}) {
  const cost = formatCostRounded(pull.cost_usd);
  const duration = formatDurationLargest(pull.work_duration_total?.seconds);
  const parts = [
    pull.total_tokens != null
      ? { kind: "tokens", label: formatTokenCountShort(pull.total_tokens) }
      : null,
    cost ? { kind: "cost", label: cost } : null,
    duration ? { kind: "duration", label: duration } : null,
  ].filter((part): part is { kind: string; label: string } => part !== null);
  if (parts.length === 0) return null;
  return (
    <span
      className="ml-auto shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground/70 tabular-nums"
      title={parts.map(({ label }) => label).join(" · ")}
    >
      {parts.map(({ kind, label }, index) => (
        <span key={kind}>
          {index > 0 ? " · " : null}
          <span
            data-linked-pull-cost={kind === "cost" ? "" : undefined}
            className={cn(
              kind === "cost" &&
                (overBudget ? COST_STOPPED_TEXT : "text-muted-foreground/70"),
            )}
          >
            {label}
          </span>
        </span>
      ))}
    </span>
  );
}

function PullPopover({
  owner,
  repo,
  pull,
  statusLabel,
  herdrStatus,
  workspacePaneId,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  statusLabel: string;
  herdrStatus?: string;
  workspacePaneId?: string;
}) {
  const focus = useFocusHerdrAgent();
  const { showError } = useToast();
  const details = [
    ["Status", statusLabel],
    ["Herdr", herdrStatus || "n/a"],
    ["Model", agentRuntimeMetadataLabel(pull.agent_runtime, pull.agent_model)],
    [
      "Tokens",
      pull.total_tokens != null ? formatTokenCount(pull.total_tokens) : "n/a",
    ],
    ["Cost", formatCost(pull.cost_usd ?? null)],
    [
      "Elapsed",
      pull.work_duration_total
        ? `${formatDuration(pull.work_duration_total.seconds)} (${WORK_BASIS_LABEL[pull.work_duration_total.basis]})`
        : "n/a",
    ],
  ];
  return (
    <div className="absolute left-7 top-full z-20 w-[380px] pt-1">
      <div className="rounded-md border bg-background p-3 text-foreground shadow-lg">
        <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-xs">
          {details.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 truncate font-medium" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 flex gap-2">
          <Link
            to="/r/$owner/$repo/pulls/$number"
            params={{ owner, repo, number: String(pull.number) }}
            className={cn(buttonVariants({ size: "sm" }), "h-8")}
          >
            <ArrowRight className="size-3.5" />
            Open PR #{pull.number}
          </Link>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-8"
            disabled={!workspacePaneId || focus.isPending}
            title={
              workspacePaneId
                ? "Open the running agent pane in Herdr"
                : "No running Herdr pane for this PR"
            }
            onClick={() => {
              if (!workspacePaneId) return;
              focus.mutate(
                { repo: `${owner}/${repo}`, paneId: workspacePaneId },
                {
                  onError: (e) =>
                    showError(
                      e instanceof Error
                        ? e.message
                        : "Failed to open in Herdr.",
                    ),
                },
              );
            }}
          >
            <Terminal className="size-3.5" />
            Open in Herdr
          </Button>
        </div>
        {workspacePaneId ? (
          <HerdrAgentInput
            repo={`${owner}/${repo}`}
            pull={pull.number}
            paneId={workspacePaneId}
            className="mt-3 border-t pt-3"
          />
        ) : null}
      </div>
    </div>
  );
}

export function LinkedPullSummaryRow({
  owner,
  repo,
  pull,
  className,
  showTitle = false,
  dimInactive = false,
  attemptComparison = false,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  className?: string;
  showTitle?: boolean;
  /** Dim merged and closed PRs when this row is rendered in an issue list. */
  dimInactive?: boolean;
  /** Show issue-detail comparison metrics and adopt/discard actions. */
  attemptComparison?: boolean;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const { showError } = useToast();
  const { data: herdrSessions } = useHerdrSessions();
  const setState = useSetPullState(owner, repo, pull.number);
  const repoFullName = `${owner}/${repo}`;
  const workspace = findPullHerdrWorkspace(
    herdrSessions,
    repoFullName,
    pull.number,
  )?.workspace;
  const agentWorking = isPullHerdrWorking(
    herdrSessions,
    repoFullName,
    pull.number,
  );
  const operationalStatus =
    linkedPullStatus(pull, { agentWorking }) ?? linkedPullStateBadge(pull);
  const status = attemptComparison
    ? pull.merged
      ? { tone: "merged" as const, label: "merged", title: "Merged" }
      : pull.state === "closed"
        ? { tone: "closed" as const, label: "closed", title: "Closed" }
        : pull.draft === false
          ? {
              tone: "review-passed" as const,
              label: "ready",
              title: "Ready for review",
            }
          : { tone: "open" as const, label: "open", title: "Open draft" }
    : operationalStatus;
  const costStopped = costStoppedBadge(pull);
  const passed = !attemptComparison && status.tone === "review-passed";
  const needsAttention =
    operationalStatus.tone === "conflict" ||
    operationalStatus.tone === "review-changes" ||
    workspace?.status === "blocked";
  const isDone = pull.merged || pull.state === "closed";
  // The indigo pulse/ring means a live herdr agent is actively working (signal
  // B). A dirty worktree alone no longer triggers it (#1125), so a session that
  // ended with uncommitted changes stops reading "working" forever.
  const showWorkingEffect = !isDone && agentWorking;
  // Idle: an open PR with no live agent and nothing needing attention. Its bot
  // icon dims to the same inactive tone as done rows (isDone opacity-45 below),
  // rather than looking active. conflict/changes keep a bright icon + red dot,
  // and a cost-stopped PR stays bright — it is stalled and needs a human, not idle.
  const isIdle =
    !isDone && !showWorkingEffect && !needsAttention && !costStopped;
  const runtimeMetadata = agentRuntimeMetadataLabel(
    pull.agent_runtime,
    pull.agent_model,
  );

  return (
    <div
      data-linked-pull-row
      aria-label={`Linked PR #${pull.number}: ${pull.title}`}
      className={cn(
        "group/linked-pull relative min-w-0 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60",
        attemptComparison && "rounded-md border bg-muted/20 p-3",
        className,
      )}
      onMouseEnter={() => setPopoverOpen(true)}
      onMouseLeave={() => setPopoverOpen(false)}
      onFocus={() => setPopoverOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setPopoverOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setPopoverOpen(false);
      }}
    >
      {/* opacity lives on the content wrapper, not the row container, so the
          PullPopover (rendered as a sibling below) never inherits opacity-45. */}
      <div
        data-linked-pull-content
        className={cn(
          "flex min-w-0 items-center gap-2",
          dimInactive && isDone && "opacity-45",
        )}
      >
        <span
          className={cn(
            "relative flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
            showWorkingEffect &&
              "animate-[linked-pull-pulse_2.4s_ease-out_infinite] bg-indigo-100 text-indigo-700 ring-1 ring-indigo-500/70 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-300/80",
            isIdle && "opacity-45",
          )}
        >
          <Bot className="size-3" aria-hidden="true" />
          {needsAttention ? (
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-[1.5px] border-background bg-destructive" />
          ) : null}
        </span>
        <span className="min-w-0 shrink truncate" title={runtimeMetadata}>
          {runtimeMetadata}
        </span>
        <span aria-hidden="true" className="shrink-0 text-muted-foreground/70">
          ·
        </span>
        <Link
          to="/r/$owner/$repo/pulls/$number"
          params={{ owner, repo, number: String(pull.number) }}
          className="flex shrink-0 items-center font-medium text-primary hover:underline"
        >
          PR #{pull.number}
        </Link>
        <LinkedGithubPrBadge github_pull={pull.github_pull} />
        {showTitle ? (
          <Link
            to="/r/$owner/$repo/pulls/$number"
            params={{ owner, repo, number: String(pull.number) }}
            className="min-w-0 flex-1 truncate text-foreground hover:underline"
            title={pull.title}
          >
            {pull.title}
          </Link>
        ) : null}
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 font-semibold",
            STATUS_TEXT[linkedPullWordTone(status.tone)],
            status.tone === "working" && "text-indigo-600 dark:text-indigo-400",
          )}
          title={status.title}
        >
          {passed ? (
            <span
              className="flex size-3.5 items-center justify-center rounded-full bg-green-600 text-[9px] leading-none text-white"
              aria-label="passed"
            >
              <Check className="size-2.5" aria-hidden="true" />
            </span>
          ) : null}
          {status.label}
        </span>
        {attemptComparison && agentWorking ? (
          <span
            className="shrink-0 font-semibold text-indigo-600 dark:text-indigo-400"
            title="Working in the PR worktree"
          >
            working
          </span>
        ) : null}
        {costStopped ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 font-medium",
              COST_STOPPED_TEXT,
            )}
            title={costStopped.title}
          >
            <TriangleAlert className="size-3" aria-hidden="true" />
            over budget
          </span>
        ) : null}
        <Metrics pull={pull} overBudget={costStopped !== null} />
      </div>
      {attemptComparison ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 pl-[26px]">
          <span className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground/70">Diff</span>
            <DiffStat
              additions={pull.additions ?? 0}
              deletions={pull.deletions ?? 0}
            />
          </span>
          <span>
            <span className="text-muted-foreground/70">Review</span>{" "}
            <span className="font-medium text-foreground">
              {pull.review_state === "PASSED"
                ? "pass"
                : pull.review_state === "CHANGES_REQUESTED"
                  ? "request changes"
                  : pull.review_state === "READY_FOR_RE_REVIEW" ||
                      pull.review_state === "STALE"
                    ? "re-review"
                    : pull.review_state === "COMMENTED"
                      ? "commented"
                      : "not reviewed"}
            </span>
          </span>
          {(pull.base_commits_behind ?? 0) > 0 ? (
            <span className="font-medium text-amber-700 dark:text-amber-300">
              base is {pull.base_commits_behind} commit
              {pull.base_commits_behind === 1 ? "" : "s"} behind
            </span>
          ) : null}
          <span className="ml-auto inline-flex items-center gap-2">
            <Link
              to="/r/$owner/$repo/pulls/$number"
              params={{ owner, repo, number: String(pull.number) }}
              className={cn(
                buttonVariants({ variant: "secondary", size: "sm" }),
                "h-7",
              )}
            >
              <ArrowRight className="size-3.5" />
              {pull.state === "open" && !pull.merged
                ? "Review & merge"
                : "View PR"}
            </Link>
            {pull.state === "open" && !pull.merged ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7 text-destructive hover:text-destructive"
                onClick={() => setConfirmingDiscard(true)}
              >
                <Trash2 className="size-3.5" />
                Discard
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
      {popoverOpen ? (
        <PullPopover
          owner={owner}
          repo={repo}
          pull={pull}
          statusLabel={status.label}
          herdrStatus={workspace?.status}
          workspacePaneId={workspace?.pane_id}
        />
      ) : null}
      {confirmingDiscard ? (
        <DiscardAttemptDialog
          pullNumber={pull.number}
          pending={setState.isPending}
          onCancel={() => setConfirmingDiscard(false)}
          onConfirm={() =>
            setState.mutate("closed", {
              onSuccess: () => setConfirmingDiscard(false),
              onError: (error) =>
                showError(
                  error instanceof Error
                    ? error.message
                    : "Failed to discard attempt.",
                ),
            })
          }
        />
      ) : null}
    </div>
  );
}

function DiscardAttemptDialog({
  pullNumber,
  pending,
  onConfirm,
  onCancel,
}: {
  pullNumber: number;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[6vh]"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Discard PR #${pullNumber}?`}
        className="flex w-full max-w-md flex-col rounded-lg border bg-background p-5 text-foreground shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Discard PR #{pullNumber}?</h2>
        <p className="mt-3 text-sm text-muted-foreground">
          This closes the PR without merging it. The issue and other attempts
          stay open.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Discard attempt
          </Button>
        </div>
      </div>
    </div>
  );
}
