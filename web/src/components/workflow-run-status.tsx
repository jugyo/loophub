// Workflow run state section for issue / PR detail (#1008). Shows the display state of the run linked
// to an issue / PR: workflow name, status, current step (as an Execute → Verify
// tracker), and rework count / limit. The run row is the display-state source (workflow design:
// CLI / UI) —
// this deliberately does not re-derive step-completion truth (that stays with
// `workflow step status` — HEAD vs the pinned Verify review).
//
// - needs human (#1307): a run with `needs_human_reason` set is waiting for an explicit human
//   instruction. Surfaces that reason (plus the latest Verify review summary when present) and
//   links to the issue, where the parent files its escalation comment.
// - ended: the run's linked PR closed or merged. That is the run's only terminal condition — the run
//   row never records one — so the badge, the duration ticker and the notices all read it from
//   `pr_closed` / `pr_merged`.
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
import { workflowRunEnded } from "@/lib/workflow-run";
import { useHerdrSessions } from "@/queries/terminal";
import { useWorkflowRunTotalCost } from "@/queries/workflow-runs";

const RUNNING_STATUS = {
  label: "Running",
  tone: "working" as NonNullable<BadgeProps["tone"]>,
};
// The run ended when its linked PR closed or merged. A passing Verify does not reach it — that
// keeps the run running + `verification_status: verified` (#1513).
const ENDED_STATUS = {
  label: "Completed",
  tone: "review-passed" as NonNullable<BadgeProps["tone"]>,
};

// Waiting for an explicit human instruction (#1307).
function needsHuman(state: WorkflowRunState): boolean {
  return state.needs_human_reason !== null;
}

function formatWorkflowRunTotalCost(total: WorkflowRunTotalCost): string {
  if (total.cost_status === "unknown") return "Unknown";
  if (total.cost_status === "pending") return "Pending";
  if (total.cost_status === "not_recorded") return "n/a";
  const formatted = formatCost(total.cost_usd);
  return total.cost_status === "partial" ? `${formatted}+` : formatted;
}

function WorkflowRunDuration({ state }: { state: WorkflowRunState }) {
  const running = !workflowRunEnded(state);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const startedAtMs = new Date(state.created_at).getTime();
  // An ended run only has a total when its end was recorded, which legacy rows carry and current
  // ones do not — the PR says the run ended, not when it stopped working. Show nothing rather than
  // present time-since-start as a total.
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

  const budgetResumePending =
    acknowledgedCostHold !== null &&
    acknowledgedCostHold.limitUsd === state.cost_limit_usd &&
    acknowledgedCostHold.reason === state.needs_human_reason &&
    !state.cost_limit_increase_available;
  const displayState = budgetResumePending
    ? { ...state, needs_human_reason: null }
    : state;
  // The end outranks every other display: a hold or a stale verification on an ended run cannot
  // lead anywhere.
  const runEnded = workflowRunEnded(state);
  const status = runEnded
    ? ENDED_STATUS
    : needsHuman(displayState)
      ? { label: "Needs human", tone: "cost-stopped" as const }
      : state.done
        ? { label: "Ready to merge", tone: "review-passed" as const }
        : state.verification_status === "stale"
          ? { label: "Reverify required", tone: "review-changes" as const }
          : RUNNING_STATUS;
  const isStaleVerification =
    !runEnded &&
    state.needs_human_reason === null &&
    state.verification_status === "stale";
  const isVerified = state.verification_status === "verified";
  // Core withholds the increase from an ended run, so this is already false there. Keep the
  // condition anyway: this flag replaces the badge with the budget control, and the badge is the
  // one thing that must not disappear when a run ends.
  const overBudget = !runEnded && state.cost_limit_increase_available;

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
            {state.workflow_name ?? "workflow"}
          </span>
          <span className="text-muted-foreground">run {state.id}</span>
        </div>

        <WorkflowStepTracker
          owner={owner}
          repo={repo}
          state={displayState}
          herdrSessions={herdrSessionsError ? undefined : herdrSessions}
          herdrUnavailable={herdrSessionsError}
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
            pull={state.pr_number}
            state={state}
            onIncreased={setAcknowledgedCostHold}
          />
        ) : null}

        {runEnded ? (
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

        {needsHuman(displayState) && !runEnded && !overBudget ? (
          <NeedsHumanNotice owner={owner} repo={repo} state={displayState} />
        ) : null}

        <div
          data-debug-component="WorkflowRunMetadata"
          className="flex flex-col gap-1 text-sm text-muted-foreground"
        >
          {state.rework_count > 0 ? (
            <p>
              Rework: {state.rework_count}/{state.rework_limit}
            </p>
          ) : null}
          <WorkflowRunDuration state={state} />
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
          state={state}
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
        This run is waiting for a human instruction to its parent session.
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
