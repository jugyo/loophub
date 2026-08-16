// Workflow run state section for issue / PR detail (#1008). Shows the display state of the run linked
// to an issue / PR: workflow name, status, current step (as an Execute → Verify
// tracker), and rework count / limit. The run row is the display-state source (workflow design:
// CLI / UI) —
// this deliberately does not re-derive step-completion truth (that stays with
// `workflow step status` — HEAD vs the pinned Verify review).
//
// - needs human (#1307): a running run with `needs_human_reason` set is waiting for an explicit
//   human instruction. Surfaces that reason (plus the latest Verify review summary when present) and
//   links to the issue, where the parent files its escalation comment. Legacy terminal `blocked`
//   rows get the same prominent display.
// A running run can be verified for its current HEAD or need re-verification after HEAD advances.
//
// Renders nothing when the issue / PR has no run.

import { Link } from "@tanstack/react-router";
import { History } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkflowRunState, WorkflowRunTotalCost } from "@/api/types";
import {
  type AcknowledgedCostHold,
  WorkflowBudgetControl,
} from "@/components/linked-pull-summary";
import type { BadgeProps } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkflowRunDetailDialog } from "@/components/workflow-run-history-dialog";
import { WorkflowStepTracker } from "@/components/workflow-step-tracker";
import { formatCost } from "@/lib/session-usage";
import { formatDuration } from "@/lib/time";
import {
  workflowDisplayStage,
  workflowRunDisplayState,
} from "@/lib/workflow-run";
import { useHerdrSessions } from "@/queries/terminal";
import { useWorkflowRunTotalCost } from "@/queries/workflow-runs";

const STATUS_META: Record<
  string,
  { label: string; tone: NonNullable<BadgeProps["tone"]> }
> = {
  running: { label: "Running", tone: "working" },
  // Legacy terminal status (#1307): pre-needs-human escalations; shown like a needs-human run.
  blocked: { label: "Needs human", tone: "cost-stopped" },
  // Terminal status: the run's linked PR merged (#1808). A passing Verify does not reach it — that
  // keeps the run `running` + `verification_status: verified` (#1513).
  completed: { label: "Completed", tone: "review-passed" },
  // Legacy terminal status (#1525): the run-stop write path was removed — a cost stop now interrupts
  // only the child (Esc) and leaves the run `running`. Old rows may still be `stopped`, so keep the
  // read-only rendering for them.
  stopped: { label: "Stopped", tone: "closed" },
};

// Waiting for an explicit human instruction (#1307): a running run holding a needs-human reason,
// or a legacy terminal `blocked` row.
function needsHuman(state: WorkflowRunState): boolean {
  state = workflowRunDisplayState(state);
  return (
    (state.status === "running" && state.needs_human_reason !== null) ||
    state.status === "blocked"
  );
}

function formatWorkflowRunTotalCost(total: WorkflowRunTotalCost): string {
  if (total.cost_status === "unknown") return "Unknown";
  if (total.cost_status === "pending") return "Pending";
  if (total.cost_status === "not_recorded") return "n/a";
  const formatted = formatCost(total.cost_usd);
  return total.cost_status === "partial" ? `${formatted}+` : formatted;
}

function WorkflowRunDuration({ state }: { state: WorkflowRunState }) {
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
    <p
      data-debug-component="WorkflowRunDuration"
      className="text-sm text-muted-foreground"
    >
      Duration: {duration} {running ? "elapsed" : "total"}
    </p>
  );
}

export function WorkflowRunStatusSection({
  owner,
  repo,
  state,
  showDetail = false,
  observeHerdrSessions = false,
}: {
  owner: string;
  repo: string;
  state: WorkflowRunState | null | undefined;
  showDetail?: boolean;
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
  // PR detail can make this section the only Herdr consumer in the tab. Standalone renderers keep
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
  const status = needsHuman(displayState)
    ? { label: "Needs human", tone: "cost-stopped" as const }
    : workflowDisplayStage(displayState) === "merged"
      ? { label: "Merged", tone: "review-passed" as const }
      : workflowDisplayStage(displayState) === "ready_to_merge"
        ? { label: "Ready to merge", tone: "review-passed" as const }
        : displayState.status === "running" &&
            displayState.verification_status === "stale"
          ? { label: "Reverify required", tone: "review-changes" as const }
          : (STATUS_META[displayState.status] ?? {
              label: displayState.status,
              tone: "unknown" as const,
            });
  const completed = displayState.status === "completed";
  const isStaleVerification =
    displayState.status === "running" &&
    displayState.needs_human_reason === null &&
    displayState.verification_status === "stale";
  const isVerified =
    !displayState.pr_merged && displayState.verification_status === "verified";
  const overBudget = displayState.cost_limit_increase_available;

  return (
    <section
      data-debug-component="WorkflowRunStatusSection"
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">Workflow</h2>
      <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {!overBudget ? (
            <Badge tone={status.tone}>{status.label}</Badge>
          ) : null}
          <span className="font-medium">
            {displayState.workflow_name ?? "workflow"}
          </span>
          <span className="text-muted-foreground">run {displayState.id}</span>
        </div>

        <WorkflowStepTracker
          owner={owner}
          repo={repo}
          state={displayState}
          herdrSessions={herdrSessionsError ? undefined : herdrSessions}
          herdrUnavailable={herdrSessionsError}
          showWorkflowNode
          size="md"
          overBudget={overBudget}
        />

        <div className="flex items-center justify-between gap-3 border-t pt-3 text-sm">
          <span className="text-muted-foreground">Total cost</span>
          <span
            className={
              totalCost.isError
                ? "text-right text-destructive"
                : "font-medium tabular-nums"
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
        </div>

        {overBudget ? (
          <WorkflowBudgetControl
            owner={owner}
            repo={repo}
            pull={displayState.pr_number}
            state={displayState}
            onIncreased={setAcknowledgedCostHold}
          />
        ) : null}

        {completed ? (
          <p className="text-sm text-muted-foreground">
            The Workflow run is completed.
          </p>
        ) : null}

        {isVerified ? (
          <p className="text-sm text-muted-foreground">
            Verify passed for the current HEAD.
          </p>
        ) : isStaleVerification ? (
          <p className="text-sm text-muted-foreground">
            HEAD changed after Verify passed — a fresh Verify is required.
          </p>
        ) : null}

        {needsHuman(displayState) && !overBudget ? (
          <NeedsHumanNotice owner={owner} repo={repo} state={displayState} />
        ) : null}

        <div
          data-debug-component="WorkflowRunMetadata"
          className="flex flex-col gap-1 text-sm text-muted-foreground"
        >
          {displayState.rework_count > 0 ? (
            <p>
              Rework: {displayState.rework_count}/{displayState.rework_limit}
            </p>
          ) : null}
          <WorkflowRunDuration state={displayState} />
        </div>

        {showDetail ? (
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setDetailOpen(true)}
            >
              <History className="size-3.5" /> Detail
            </Button>
          </div>
        ) : null}
      </div>
      {detailOpen ? (
        <WorkflowRunDetailDialog
          owner={owner}
          repo={repo}
          state={displayState}
          onClose={() => setDetailOpen(false)}
        />
      ) : null}
    </section>
  );
}

// Needs human means the parent escalated (workflow design: parent transitions): it filed an issue
// comment summarizing the situation and holds the run waiting for an explicit human instruction to
// its session (#1307). Surface the stored wait reason, point the human at the issue, and add the
// latest Verify review summary when one exists. Legacy terminal `blocked` rows render the same way,
// minus the resumability (their parent is gone).
function NeedsHumanNotice({
  owner,
  repo,
  state,
}: {
  owner: string;
  repo: string;
  state: WorkflowRunState;
}) {
  const review = state.latest_review;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p className="font-medium text-amber-700 dark:text-amber-300">
        {state.status === "blocked"
          ? "This run was escalated to a human and is no longer running."
          : "This run is waiting for a human instruction to its parent session."}
      </p>
      {state.needs_human_reason !== null ? (
        <p className="text-muted-foreground">{state.needs_human_reason}</p>
      ) : null}
      {review && review.event === "request_changes" ? (
        <p className="text-muted-foreground">
          Latest review requested changes
          {review.findings_count > 0
            ? ` (${review.findings_count} finding${
                review.findings_count === 1 ? "" : "s"
              })`
            : ""}
          : {review.summary}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Link
          to="/r/$owner/$repo/issues/$number"
          params={{ owner, repo, number: String(state.issue_number) }}
          className="text-link hover:underline"
        >
          Read issue #{state.issue_number}
        </Link>
      </div>
    </div>
  );
}
