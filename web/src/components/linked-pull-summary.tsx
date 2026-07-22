import { Link } from "@tanstack/react-router";
import { ArrowRight, TriangleAlert } from "lucide-react";
import type { HerdrAgent, HerdrSessions, LinkedPull } from "@/api/types";
import { AgentBotIcon } from "@/components/agent-bot-icon";
import { DiffStat } from "@/components/diff-stat";
import { HerdrAgentInput } from "@/components/herdr-agent-input";
import {
  findPullHerdrWorkspace,
  isPullHerdrWorking,
} from "@/components/herdr-badge";
import { LinkedGithubPrBadge } from "@/components/linked-github-pr-badge";
import { AgentTree, pullHerdrAgents } from "@/components/pull-herdr-section";
import { useToast } from "@/components/toast";
import { Button, buttonVariants } from "@/components/ui/button";
import { WorkflowStepTracker } from "@/components/workflow-step-tracker";
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
import { useHoverPopover } from "@/lib/use-hover-popover";
import { cn } from "@/lib/utils";
import { useSetPullState } from "@/queries/pulls";
import { useHerdrSessions } from "@/queries/terminal";
import { useWorkflowRunForPull } from "@/queries/workflow-runs";
import { codingAgentLabel } from "../../../core/runtimes.ts";

const STATUS_TEXT: Record<StatusWordTone, string> = {
  danger: "text-destructive",
  ready: "text-green-600 dark:text-green-400",
  done: "text-violet-500 dark:text-violet-400",
  muted: "text-muted-foreground",
};

const COST_STOPPED_TEXT = "text-amber-700 dark:text-amber-300";

function linkedPullAttemptStatus(pull: LinkedPull) {
  return pull.merged
    ? { tone: "merged" as const, label: "merged", title: "Merged" }
    : pull.state === "closed"
      ? { tone: "closed" as const, label: "closed", title: "Closed" }
      : { tone: "open" as const, label: "open", title: "Open" };
}

const WORK_BASIS_LABEL: Record<
  NonNullable<LinkedPull["work_duration_total"]>["basis"],
  string
> = {
  merged: "merged",
  closed: "closed",
  in_review: "in review",
  in_progress: "in progress",
};

function agentRuntimeMetadataLabel(runtime?: string, model?: string): string {
  const parts = [
    // codingAgentLabel maps a known runtime id to its display label and falls back to the raw
    // string for an unknown runtime (core/runtimes.ts) — the same behavior the local if/else had.
    runtime ? codingAgentLabel(runtime) : null,
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

// Compact workflow-run step tracker for a PR list row. Renders nothing when the PR has no linked
// workflow run. Uses `useWorkflowRunForPull`, which is event-poll-invalidated (lib/event-keys.ts),
// so the tracker stays fresh as the run advances. The tracker itself is the shared
// WorkflowStepTracker, also used by the detail Workflow run section.
function WorkflowMiniProgress({
  owner,
  repo,
  pull,
  herdrSessions,
  herdrUnavailable,
  onStageInteract,
  showWorkflowNode = false,
  working,
  conflict,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  herdrSessions?: HerdrSessions;
  herdrUnavailable?: boolean;
  onStageInteract?: () => void;
  showWorkflowNode?: boolean;
  /** Whether the linked agent is actively working (glow the current stage pill). */
  working: boolean;
  /** PR is in merge conflict — flip the terminal Done pill to "Conflict!" (#1659). */
  conflict: boolean;
}) {
  const { data: state } = useWorkflowRunForPull(owner, repo, pull.number);
  if (!state) return null;
  return (
    <WorkflowStepTracker
      state={state}
      owner={owner}
      repo={repo}
      herdrSessions={herdrSessions}
      herdrUnavailable={herdrUnavailable}
      onStageInteract={onStageInteract}
      showWorkflowNode={showWorkflowNode}
      size="sm"
      working={working}
      conflict={conflict}
    />
  );
}

function PullPopover({
  owner,
  repo,
  pull,
  statusLabel,
  herdrStatus,
  workspacePaneId,
  agents,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  statusLabel: string;
  herdrStatus?: string;
  workspacePaneId?: string;
  agents: HerdrAgent[];
}) {
  const details = [
    ["Status", statusLabel],
    herdrStatus === "working" ? null : ["Herdr", herdrStatus || "n/a"],
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
  ].filter((detail): detail is [string, string] => detail !== null);
  return (
    <div className="absolute left-7 top-full z-20 w-[380px] pt-1">
      <div className="rounded-md border bg-background p-3 text-foreground shadow-lg">
        <div className="mb-3 border-b pb-2 text-sm font-semibold">
          <Link
            to="/r/$owner/$repo/pulls/$number"
            params={{ owner, repo, number: String(pull.number) }}
            className="text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            PR #{pull.number}
          </Link>
        </div>
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
        {agents.length > 0 ? (
          <div className="mt-3">
            <AgentTree owner={owner} repo={repo} agents={agents} />
          </div>
        ) : null}
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
  popoverTrigger = "row",
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  className?: string;
  showTitle?: boolean;
  /** Dim merged and closed PRs when this row is rendered in an issue list. */
  dimInactive?: boolean;
  /** Show issue-detail comparison metrics and review/close actions. */
  attemptComparison?: boolean;
  /** Limit hover activation to the PR link while keeping the row as the popover boundary. */
  popoverTrigger?: "row" | "pull-link";
}) {
  const popover = useHoverPopover();
  const { showError } = useToast();
  const { data: herdrSessions, isError: herdrSessionsError } =
    useHerdrSessions();
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
    linkedPullStatus(pull) ?? linkedPullStateBadge(pull);
  const status = attemptComparison
    ? linkedPullAttemptStatus(pull)
    : operationalStatus;
  const costStopped = costStoppedBadge(pull);
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
  const pullAgents = pullHerdrAgents(
    herdrSessionsError ? undefined : herdrSessions,
    owner,
    repo,
    pull.number,
  );
  const linkTriggersPopover = popoverTrigger === "pull-link";

  return (
    <div
      data-debug-component="LinkedPullSummaryRow"
      data-linked-pull-row
      aria-label={`Linked PR #${pull.number}: ${pull.title}`}
      className={cn(
        "group/linked-pull relative min-w-0 rounded-sm px-2 py-1 text-xs text-muted-foreground",
        !linkTriggersPopover && "hover:bg-muted/60",
        attemptComparison && "rounded-md border bg-muted/20 p-3",
        className,
      )}
      onMouseEnter={linkTriggersPopover ? undefined : popover.onMouseEnter}
      onMouseLeave={popover.onMouseLeave}
      onFocus={linkTriggersPopover ? undefined : popover.onFocus}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          popover.close();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") popover.close();
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
        <AgentBotIcon
          working={showWorkingEffect}
          needsAttention={needsAttention}
          inactive={isIdle}
        />
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
          onMouseEnter={linkTriggersPopover ? popover.onMouseEnter : undefined}
          onMouseLeave={linkTriggersPopover ? popover.cancelPending : undefined}
          onFocus={linkTriggersPopover ? popover.onFocus : undefined}
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
        <WorkflowMiniProgress
          owner={owner}
          repo={repo}
          pull={pull}
          herdrSessions={herdrSessionsError ? undefined : herdrSessions}
          herdrUnavailable={herdrSessionsError}
          onStageInteract={popover.close}
          showWorkflowNode
          working={showWorkingEffect}
          conflict={operationalStatus.tone === "conflict"}
        />
        <Metrics pull={pull} overBudget={costStopped !== null} />
      </div>
      {attemptComparison ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 pl-[26px]">
          {/* A PR with no commits yet has a meaningless `+0 −0` diff and "not
              reviewed" state (#1240) — hide both until work lands. */}
          {(pull.commits_ahead ?? 0) > 0 ? (
            <>
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
            </>
          ) : null}
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
                className="h-7"
                disabled={setState.isPending}
                onClick={() =>
                  setState.mutate("closed", {
                    onError: (error) =>
                      showError(
                        error instanceof Error
                          ? error.message
                          : "Failed to close PR.",
                      ),
                  })
                }
              >
                Close
              </Button>
            ) : null}
          </span>
        </div>
      ) : null}
      {popover.open ? (
        <PullPopover
          owner={owner}
          repo={repo}
          pull={pull}
          statusLabel={status.label}
          herdrStatus={workspace?.status}
          workspacePaneId={workspace?.pane_id}
          agents={pullAgents}
        />
      ) : null}
    </div>
  );
}

export function LinkedPullAttemptSummaryRow({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
}) {
  const status = linkedPullAttemptStatus(pull);
  const { data: herdrSessions, isError: herdrSessionsError } =
    useHerdrSessions();
  const working = isPullHerdrWorking(
    herdrSessions,
    `${owner}/${repo}`,
    pull.number,
  );

  return (
    <div
      data-debug-component="LinkedPullAttemptSummaryRow"
      aria-label={`Linked PR #${pull.number}: ${pull.title}`}
      className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm"
    >
      <Link
        to="/r/$owner/$repo/pulls/$number"
        params={{ owner, repo, number: String(pull.number) }}
        className="shrink-0 font-medium text-primary hover:underline"
      >
        PR #{pull.number}
      </Link>
      <Link
        to="/r/$owner/$repo/pulls/$number"
        params={{ owner, repo, number: String(pull.number) }}
        className="min-w-0 flex-1 truncate text-foreground hover:underline"
        title={pull.title}
      >
        {pull.title}
      </Link>
      <WorkflowMiniProgress
        owner={owner}
        repo={repo}
        pull={pull}
        herdrSessions={herdrSessionsError ? undefined : herdrSessions}
        herdrUnavailable={herdrSessionsError}
        working={working}
        conflict={pull.mergeable_state === "conflict"}
      />
      <span
        className={cn(
          "shrink-0 font-semibold",
          STATUS_TEXT[linkedPullWordTone(status.tone)],
        )}
        title={status.title}
      >
        {status.label}
      </span>
    </div>
  );
}
