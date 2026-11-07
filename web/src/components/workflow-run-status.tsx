// One-line Workflow run summary for PR detail (#1008): the step tracker, total cost, duration and a
// Detail button that opens the run detail dialog, where the status, workflow name / run number,
// rework count and Verify state live. The run row is the display-state source (workflow design:
// CLI / UI) — this deliberately does not re-derive step-completion truth (that stays with
// `workflow step status` — HEAD vs the pinned Verify review).
//
// The `md` variant sits under the PR's badges and also carries the cost / rework limit controls
// while they apply; the `sm` variant rides in the compact sticky header.
//
// Renders nothing when the PR has no run.

import { History } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkflowRunState, WorkflowRunTotalCost } from "@/api/types";
import {
  type AcknowledgedCostHold,
  WorkflowBudgetControl,
  WorkflowReworkControl,
} from "@/components/linked-pull-summary";
import { Button } from "@/components/ui/button";
import { WorkflowRunDetailDialog } from "@/components/workflow-run-history-dialog";
import { WorkflowStepTracker } from "@/components/workflow-step-tracker";
import { formatCost } from "@/lib/session-usage";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { workflowRunDisplayState } from "@/lib/workflow-run";
import { useHerdrSessions } from "@/queries/terminal";
import { useWorkflowRunTotalCost } from "@/queries/workflow-runs";

function formatWorkflowRunTotalCost(total: WorkflowRunTotalCost): string {
  if (total.cost_status === "unknown") return "Unknown";
  if (total.cost_status === "pending") return "Pending";
  if (total.cost_status === "not_recorded") return "n/a";
  const formatted = formatCost(total.cost_usd);
  return total.cost_status === "partial" ? `${formatted}+` : formatted;
}

function WorkflowRunDuration({
  state,
  label,
}: {
  state: WorkflowRunState;
  label: boolean;
}) {
  state = workflowRunDisplayState(state);
  const running = state.status === "running";
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const startedAtMs = new Date(state.created_at).getTime();
  const endedAtMs = running
    ? nowMs
    : state.ended_at
      ? new Date(state.ended_at).getTime()
      : Number.NaN;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return null;

  const duration = formatDuration((endedAtMs - startedAtMs) / 1000);
  return (
    <span
      data-debug-component="WorkflowRunDuration"
      title={running ? "Elapsed" : "Total"}
      className="shrink-0 text-muted-foreground"
    >
      {label ? "Duration " : null}
      <span className="font-medium text-foreground tabular-nums">
        {duration}
      </span>
    </span>
  );
}

export function WorkflowRunSummary({
  owner,
  repo,
  state,
  size = "md",
  observeHerdrSessions = false,
}: {
  owner: string;
  repo: string;
  state: WorkflowRunState | null | undefined;
  /** `sm` is the compact header variant: no labels and no run controls. */
  size?: "sm" | "md";
  observeHerdrSessions?: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [acknowledgedCostHold, setAcknowledgedCostHold] =
    useState<AcknowledgedCostHold | null>(null);
  const totalCost = useWorkflowRunTotalCost(
    owner,
    repo,
    state?.id ?? 0,
    state !== null && state !== undefined,
  );
  // PR detail can make this summary the only Herdr consumer in the tab. Standalone renderers keep
  // the query disabled so opening the history dialog remains their first network boundary.
  const { data: herdrSessions, isError: herdrSessionsError } = useHerdrSessions(
    { enabled: observeHerdrSessions },
  );
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
  const overBudget = displayState.cost_limit_increase_available;
  const md = size === "md";

  return (
    <div
      data-debug-component="WorkflowRunSummary"
      className={cn("flex flex-col gap-3", md ? "min-w-0" : "shrink-0")}
    >
      <div
        className={cn(
          "flex items-center gap-x-3",
          md ? "flex-wrap gap-y-2 text-sm" : "text-xs",
        )}
      >
        <WorkflowStepTracker
          owner={owner}
          repo={repo}
          state={displayState}
          herdrSessions={herdrSessionsError ? undefined : herdrSessions}
          herdrUnavailable={herdrSessionsError}
          showWorkflowNode
          size={size}
          overBudget={md && overBudget}
        />
        <span className="shrink-0 text-muted-foreground">
          {md ? "Total cost " : null}
          <span
            className={
              totalCost.isError
                ? "text-destructive"
                : "font-medium text-foreground tabular-nums"
            }
          >
            {totalCost.isLoading
              ? "…"
              : totalCost.isError
                ? "Failed to load total cost."
                : totalCost.data
                  ? formatWorkflowRunTotalCost(totalCost.data)
                  : "n/a"}
          </span>
        </span>
        <WorkflowRunDuration state={displayState} label={md} />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={cn("shrink-0", !md && "h-6 px-2")}
          onClick={() => setDetailOpen(true)}
        >
          <History className="size-3.5" /> Detail
        </Button>
      </div>

      {md && overBudget ? (
        <WorkflowBudgetControl
          owner={owner}
          repo={repo}
          pull={displayState.pr_number}
          state={displayState}
          onIncreased={setAcknowledgedCostHold}
        />
      ) : null}
      {md && displayState.rework_limit_increase_available ? (
        <WorkflowReworkControl
          owner={owner}
          repo={repo}
          pull={displayState.pr_number}
          state={displayState}
        />
      ) : null}

      {detailOpen ? (
        <WorkflowRunDetailDialog
          owner={owner}
          repo={repo}
          state={displayState}
          onClose={() => setDetailOpen(false)}
        />
      ) : null}
    </div>
  );
}
