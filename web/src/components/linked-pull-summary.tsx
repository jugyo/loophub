import { Link } from "@tanstack/react-router";
import { ArrowRight, Bot, Check, Terminal, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { LinkedPull } from "@/api/types";
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
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";

const STATUS_TEXT: Record<StatusWordTone, string> = {
  danger: "text-destructive",
  ready: "text-green-600 dark:text-green-400",
  done: "text-violet-500 dark:text-violet-400",
  muted: "text-muted-foreground",
};

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

function Metrics({ pull }: { pull: LinkedPull }) {
  const parts = [
    pull.total_tokens != null ? formatTokenCountShort(pull.total_tokens) : null,
    formatCostRounded(pull.cost_usd),
    formatDurationLargest(pull.work_duration_total?.seconds),
  ].filter((part): part is string => !!part);
  if (parts.length === 0) return null;
  return (
    <span
      className="ml-auto shrink-0 whitespace-nowrap text-right text-xs text-muted-foreground/70 tabular-nums"
      title={parts.join(" · ")}
    >
      {parts.join(" · ")}
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
    <div className="absolute left-7 top-full z-20 w-[330px] pt-1">
      <div className="rounded-md border bg-popover p-3 text-popover-foreground shadow-lg">
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
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  className?: string;
  showTitle?: boolean;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const { data: herdrSessions } = useHerdrSessions();
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
  const status =
    linkedPullStatus(pull, { agentWorking }) ?? linkedPullStateBadge(pull);
  const costStopped = costStoppedBadge(pull);
  const passed = status.tone === "review-passed";
  const needsAttention =
    status.tone === "conflict" ||
    status.tone === "review-changes" ||
    workspace?.status === "blocked";
  const isWorking = status.tone === "working";
  const isDone = pull.merged || pull.state === "closed";
  const runtimeMetadata = agentRuntimeMetadataLabel(
    pull.agent_runtime,
    pull.agent_model,
  );

  return (
    <div
      data-linked-pull-row
      aria-label={`Linked PR #${pull.number}: ${pull.title}`}
      className={cn(
        "group/linked-pull relative flex min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60",
        isDone && "opacity-45",
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
      <span
        className={cn(
          "relative flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
          isWorking &&
            "animate-[linked-pull-pulse_2.4s_ease-out_infinite] text-indigo-600",
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
      {costStopped ? (
        <span
          className="flex shrink-0 items-center gap-1 font-medium text-amber-700 dark:text-amber-300"
          title={costStopped.title}
        >
          <TriangleAlert className="size-3" aria-hidden="true" />
          over budget
        </span>
      ) : null}
      <Metrics pull={pull} />
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
    </div>
  );
}
