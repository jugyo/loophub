import { Link } from "@tanstack/react-router";
import { MessageSquare, RefreshCw, TriangleAlert } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import type { HerdrSessions, LinkedPull, WorkflowRunState } from "@/api/types";
import { findPullHerdrWorkspace } from "@/components/herdr-badge";
import { LinkedGithubPrBadge } from "@/components/linked-github-pr-badge";
import { useToast } from "@/components/toast";
import { WorkflowStepTracker } from "@/components/workflow-step-tracker";
import { YesNoPrompt } from "@/components/yes-no-prompt";
import {
  costStoppedBadge,
  linkedPullStateBadge,
  linkedPullStatus,
} from "@/lib/badges";
import {
  formatCost,
  formatTokenCount,
  formatTokenCountShort,
} from "@/lib/session-usage";
import { formatDuration } from "@/lib/time";
import { useHoverPopover } from "@/lib/use-hover-popover";
import { cn } from "@/lib/utils";
import { workflowRunDisplayState } from "@/lib/workflow-run";
import { useHerdrSessions } from "@/queries/terminal";
import {
  useIncreaseWorkflowRunCostLimit,
  useWorkflowRunForPull,
} from "@/queries/workflow-runs";
import { codingAgentLabel } from "../../../core/runtimes.ts";

const COST_STOPPED_TEXT = "text-amber-700 dark:text-amber-300";

// Shared shape of the row's "over budget" marker, worn by both the PR-level cost-stop badge and the
// workflow run's budget action so the two read as the same cue.
const OVER_BUDGET_BADGE =
  "flex shrink-0 items-center gap-1 whitespace-nowrap font-medium";

export type AcknowledgedCostHold = {
  limitUsd: number;
  reason: string;
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

type MetadataItem = { key: string; node: ReactNode };

// The run totals a human scans on the row: how many tokens it took, how much it cost, how long it
// has been going. Each total is its own item, so the row's one separator rule covers them too.
function metricItems(pull: LinkedPull, overBudget: boolean): MetadataItem[] {
  const cost = formatCostRounded(pull.cost_usd);
  const duration = formatDurationLargest(pull.work_duration_total?.seconds);
  return [
    pull.total_tokens != null
      ? { key: "tokens", label: formatTokenCountShort(pull.total_tokens) }
      : null,
    cost ? { key: "cost", label: cost } : null,
    duration ? { key: "duration", label: duration } : null,
  ]
    .filter((part): part is { key: string; label: string } => part !== null)
    .map(({ key, label }) => ({
      key,
      node: (
        <span
          data-linked-pull-cost={key === "cost" ? "" : undefined}
          className={cn(
            "whitespace-nowrap tabular-nums",
            key === "cost" && overBudget
              ? COST_STOPPED_TEXT
              : "text-muted-foreground/70",
          )}
        >
          {label}
        </span>
      ),
    }));
}

// #2147: how many Execute -> Verify loops the PR's workflow run has taken. The looping arrows carry
// the meaning, so the row spends no width on the word "rework" and reads as a count at a glance.
function WorkflowReworkCount({ count }: { count: number }) {
  return (
    <span
      data-linked-pull-rework
      className="flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums text-muted-foreground/70"
      title={`Workflow rework ×${count}`}
    >
      <RefreshCw className="size-3" aria-hidden="true" />
      {count}
    </span>
  );
}

// #2152: how much has been said on the PR — its comments plus every diff comment, as one number.
// Icon and count only, like the diff view's own count, so it spends no width on a label.
// #2394: the count is also the way in — it links to the PR's Comments section, so reading what was
// said is one click from the row instead of opening the PR and scrolling to the bottom.
function CommentCount({
  owner,
  repo,
  number,
  count,
}: {
  owner: string;
  repo: string;
  number: number;
  count: number;
}) {
  return (
    <Link
      to="/r/$owner/$repo/pulls/$number"
      params={{ owner, repo, number: String(number) }}
      hash="comments"
      aria-label={`${count} ${count === 1 ? "comment" : "comments"}`}
      className="flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums text-muted-foreground/70 hover:text-foreground hover:underline"
    >
      <MessageSquare className="size-3" aria-hidden="true" />
      {count}
    </Link>
  );
}

// #2245: the row's metadata is one dot-separated list — the agent, the rework count, each run
// total, and how much has been said on the PR. Which items are present is decided here and nowhere
// else: an item that decided its own absence would leave the list holding a separator for it, which
// is how the rework count came to sit against its neighbours with no dot between them. A zero
// rework count or no comments still says nothing, so a row with neither spends no width on them.
function RowMetadata({
  owner,
  repo,
  pull,
  runtimeMetadata,
  overBudget,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  runtimeMetadata: string;
  overBudget: boolean;
}) {
  const items = [
    {
      key: "agent",
      node: (
        <span
          className="max-w-40 truncate text-muted-foreground"
          title={runtimeMetadata}
        >
          {runtimeMetadata}
        </span>
      ),
    },
    pull.workflow_rework_count
      ? {
          key: "rework",
          node: <WorkflowReworkCount count={pull.workflow_rework_count} />,
        }
      : null,
    ...metricItems(pull, overBudget),
    pull.total_comments
      ? {
          key: "comments",
          node: (
            <CommentCount
              owner={owner}
              repo={repo}
              number={pull.number}
              count={pull.total_comments}
            />
          ),
        }
      : null,
  ].filter((item): item is MetadataItem => item !== null);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {items.map(({ key, node }, index) => (
        <Fragment key={key}>
          {index > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground/70">
              ·
            </span>
          ) : null}
          {node}
        </Fragment>
      ))}
    </div>
  );
}

// The row's marker for a run held on its cost limit (#1828). Only the badge sits in the row; the
// increase question opens from it on hover or focus, so the row spends no width on a budget it is
// still inside (#1906). Once the question has been answered "No" for this limit the badge stays —
// the run is still held — but stops offering the action until a later crossing at the higher limit.
export function WorkflowBudgetControl({
  owner,
  repo,
  pull,
  state,
  onInteract,
  onIncreased,
}: {
  owner: string;
  repo: string;
  pull: number;
  state: WorkflowRunState;
  onInteract?: () => void;
  onIncreased?: (hold: AcknowledgedCostHold) => void;
}) {
  const increaseCostLimit = useIncreaseWorkflowRunCostLimit(owner, repo, pull);
  const { showError } = useToast();
  const [declinedLimitUsd, setDeclinedLimitUsd] = useState<number | null>(null);
  const popover = useHoverPopover();
  const dialogId = `workflow-run-${state.id}-budget`;
  const nextLimit = state.cost_limit_usd + state.cost_increment_usd;
  const askable = declinedLimitUsd !== state.cost_limit_usd;
  const badge = (
    <>
      <TriangleAlert className="size-3" aria-hidden="true" />
      over budget
    </>
  );
  if (!askable) {
    return (
      <span
        data-workflow-budget
        className={cn(OVER_BUDGET_BADGE, COST_STOPPED_TEXT)}
        title={`Over budget — the run stays held at ${formatCost(state.cost_limit_usd)}`}
      >
        {badge}
      </span>
    );
  }
  return (
    <div
      data-workflow-budget
      className="relative shrink-0"
      onMouseEnter={(event) => {
        event.stopPropagation();
        onInteract?.();
        popover.onMouseEnter();
      }}
      onMouseLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        popover.onMouseLeave();
      }}
      onFocus={(event) => {
        event.stopPropagation();
        onInteract?.();
        popover.onFocus();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) popover.close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") popover.close();
      }}
    >
      <span
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-controls={popover.open ? dialogId : undefined}
        className={cn(
          OVER_BUDGET_BADGE,
          COST_STOPPED_TEXT,
          "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        )}
      >
        {badge}
      </span>
      {popover.open ? (
        <div className="absolute right-0 top-full z-30 pt-1">
          <div
            id={dialogId}
            role="dialog"
            aria-label="Workflow budget"
            className="rounded-md border bg-background p-2 text-foreground shadow-lg"
          >
            <YesNoPrompt
              question={`Increase to ${formatCost(nextLimit)}?`}
              pending={increaseCostLimit.isPending}
              onYes={() =>
                increaseCostLimit.mutate(
                  { run: state.id, expectedLimitUsd: state.cost_limit_usd },
                  {
                    onSuccess: (result) => {
                      if (state.needs_human_reason !== null) {
                        onIncreased?.({
                          limitUsd: result.current_limit_usd,
                          reason: state.needs_human_reason,
                        });
                      }
                    },
                    onError: (error) =>
                      showError(
                        error instanceof Error
                          ? error.message
                          : "Failed to increase the workflow budget.",
                      ),
                  },
                )
              }
              onNo={() => setDeclinedLimitUsd(state.cost_limit_usd)}
            />
          </div>
        </div>
      ) : null}
    </div>
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
  workflowRunSeeded = false,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  herdrSessions?: HerdrSessions;
  herdrUnavailable?: boolean;
  onStageInteract?: () => void;
  showWorkflowNode?: boolean;
  workflowRunSeeded?: boolean;
}) {
  const { data: state } = useWorkflowRunForPull(
    owner,
    repo,
    pull.number,
    !workflowRunSeeded,
  );
  const [acknowledgedCostHold, setAcknowledgedCostHold] =
    useState<AcknowledgedCostHold | null>(null);
  useEffect(() => {
    if (
      state?.needs_human_reason === null ||
      (acknowledgedCostHold !== null &&
        state?.needs_human_reason !== acknowledgedCostHold.reason)
    ) {
      setAcknowledgedCostHold(null);
    }
  }, [state?.needs_human_reason, acknowledgedCostHold]);
  if (!state) return null;
  const terminalState = workflowRunDisplayState(state);
  const budgetResumePending =
    acknowledgedCostHold !== null &&
    acknowledgedCostHold.limitUsd === terminalState.cost_limit_usd &&
    acknowledgedCostHold.reason === terminalState.needs_human_reason &&
    !terminalState.cost_limit_increase_available;
  const displayState = budgetResumePending
    ? { ...terminalState, needs_human_reason: null }
    : terminalState;
  return (
    <>
      <WorkflowStepTracker
        state={displayState}
        owner={owner}
        repo={repo}
        herdrSessions={herdrSessions}
        herdrUnavailable={herdrUnavailable}
        onStageInteract={onStageInteract}
        showWorkflowNode={showWorkflowNode}
        size="sm"
        // The badge below already marks the hold, so the tracker drops its "needs human" (#1932).
        overBudget={displayState.cost_limit_increase_available}
      />
      {/* Nothing is shown while the run is inside its budget; a successful increase is legible from
          the badge disappearing with the hold. */}
      {displayState.cost_limit_increase_available ? (
        <WorkflowBudgetControl
          owner={owner}
          repo={repo}
          pull={pull.number}
          state={displayState}
          onInteract={onStageInteract}
          onIncreased={setAcknowledgedCostHold}
        />
      ) : null}
    </>
  );
}

function PullPopover({
  owner,
  repo,
  pull,
  statusLabel,
  herdrStatus,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  statusLabel: string;
  herdrStatus?: string;
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
      <div
        data-debug-component="PullPopover"
        className="rounded-md border bg-background p-3 text-foreground shadow-lg"
      >
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
      </div>
    </div>
  );
}

export function LinkedPullSummaryRow({
  owner,
  repo,
  pull,
  className,
  dimInactive = false,
  popoverTrigger = "row",
  workflowRunSeeded = false,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
  className?: string;
  /**
   * The row's Workflow run state already arrived with the page and was seeded into its query key
   * (#112), so the tracker reads it from cache instead of fetching per row. Surfaces that fetch
   * their rows one at a time leave this off and keep the per-PR request.
   */
  workflowRunSeeded?: boolean;
  /** Dim merged and closed PRs when this row is rendered in an issue list. */
  dimInactive?: boolean;
  /** Limit hover activation to the PR link while keeping the row as the popover boundary. */
  popoverTrigger?: "row" | "pull-link";
}) {
  const popover = useHoverPopover();
  const { data: herdrSessions, isError: herdrSessionsError } =
    useHerdrSessions();
  const repoFullName = `${owner}/${repo}`;
  const workspace = findPullHerdrWorkspace(
    herdrSessions,
    repoFullName,
    pull.number,
  )?.workspace;
  const operationalStatus =
    linkedPullStatus(pull) ?? linkedPullStateBadge(pull);
  const status = operationalStatus;
  const costStopped = costStoppedBadge(pull);
  const isDone = pull.merged || pull.state === "closed";
  const runtimeMetadata = agentRuntimeMetadataLabel(
    pull.agent_runtime,
    pull.agent_model,
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
        className,
      )}
      // When only the PR link opens the popover (#1289), the row is still the
      // region that holds the panel: returning to it cancels the pending close
      // without letting a pointer crossing the row open anything.
      onMouseEnter={
        linkTriggersPopover ? popover.keepOpen : popover.onMouseEnter
      }
      onMouseLeave={popover.onMouseLeave}
      onFocus={linkTriggersPopover ? popover.keepOpen : popover.onFocus}
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
        {costStopped ? (
          <span
            className={cn(OVER_BUDGET_BADGE, COST_STOPPED_TEXT)}
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
          workflowRunSeeded={workflowRunSeeded}
        />
        {/* Keep the GitHub link on the row's right side without making it the rightmost item; the
            existing agent and usage metadata continues to close the row. */}
        <div
          data-linked-pull-right
          className="ml-auto flex shrink-0 items-center gap-2"
        >
          <LinkedGithubPrBadge github_pull={pull.github_pull} />
          <RowMetadata
            owner={owner}
            repo={repo}
            pull={pull}
            runtimeMetadata={runtimeMetadata}
            overBudget={costStopped !== null}
          />
        </div>
      </div>
      {popover.open ? (
        <PullPopover
          owner={owner}
          repo={repo}
          pull={pull}
          statusLabel={status.label}
          herdrStatus={workspace?.status}
        />
      ) : null}
    </div>
  );
}
