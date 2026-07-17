// Workflow run state section for issue / PR detail (#1008). Shows the display state of the run linked
// to an issue / PR: workflow name, status, current step (as an Execute → Verify
// tracker), and rework count. The run row is the display-state source (workflow design: CLI / UI) —
// this deliberately does not re-derive step-completion truth (that stays with
// `workflow step status` — HEAD vs the pinned Verify review).
//
// - needs human (#1307): a running run with `needs_human_reason` set is waiting for an explicit
//   human instruction. Surfaces that reason (plus the latest Verify review summary when present) and
//   links to the issue (where the parent files its escalation comment) and the Inbox. Legacy
//   terminal `blocked` rows get the same prominent display.
// A running run can be verified for its current HEAD or need re-verification after HEAD advances.
//
// Renders nothing when the issue / PR has no run.

import { Link } from "@tanstack/react-router";
import { History } from "lucide-react";
import { useState } from "react";
import type { WorkflowRunState } from "@/api/types";
import type { BadgeProps } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkflowRunHistoryDialog } from "@/components/workflow-run-history-dialog";

const STEP_ORDER = ["execute", "verify"] as const;
type WorkflowStep = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<WorkflowStep, string> = {
  execute: "Execute",
  verify: "Verify",
};

const STATUS_META: Record<
  string,
  { label: string; tone: NonNullable<BadgeProps["tone"]> }
> = {
  running: { label: "Running", tone: "working" },
  // Legacy terminal status (#1307): pre-needs-human escalations; shown like a needs-human run.
  blocked: { label: "Needs human", tone: "cost-stopped" },
  // Legacy terminal status (#1513): the run-complete write path was removed — a passing Verify now
  // keeps the run `running` + `verification_status: verified`. Old rows may still be `completed`, so
  // keep the read-only rendering for them.
  completed: { label: "Completed", tone: "review-passed" },
  stopped: { label: "Stopped", tone: "closed" },
};

// Waiting for an explicit human instruction (#1307): a running run holding a needs-human reason,
// or a legacy terminal `blocked` row.
function needsHuman(state: WorkflowRunState): boolean {
  return (
    (state.status === "running" && state.needs_human_reason !== null) ||
    state.status === "blocked"
  );
}

function isStep(value: string): value is WorkflowStep {
  return (STEP_ORDER as readonly string[]).includes(value);
}

export function WorkflowRunStatusSection({
  owner,
  repo,
  state,
  showHistory = false,
}: {
  owner: string;
  repo: string;
  state: WorkflowRunState | null | undefined;
  showHistory?: boolean;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  if (!state) return null;

  const status = needsHuman(state)
    ? { label: "Needs human", tone: "cost-stopped" as const }
    : state.status === "running" && state.verification_status === "verified"
      ? { label: "Verified", tone: "review-passed" as const }
      : state.status === "running" && state.verification_status === "stale"
        ? { label: "Reverify required", tone: "review-changes" as const }
        : (STATUS_META[state.status] ?? {
            label: state.status,
            tone: "unknown" as const,
          });
  const currentIndex = isStep(state.current_step)
    ? STEP_ORDER.indexOf(state.current_step)
    : -1;
  const completed = state.status === "completed";
  const isStaleVerification =
    state.status === "running" &&
    state.needs_human_reason === null &&
    state.verification_status === "stale";
  const isVerified =
    state.status === "running" &&
    state.needs_human_reason === null &&
    state.verification_status === "verified";

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">
        Workflow run
      </h2>
      <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="font-medium">
            {state.workflow_name ?? "workflow"}
          </span>
          <span className="text-muted-foreground">run #{state.id}</span>
          {state.rework_count > 0 ? (
            <span className="text-muted-foreground">
              · rework ×{state.rework_count}
            </span>
          ) : null}
        </div>

        <StepTracker
          currentIndex={currentIndex}
          currentStep={state.current_step}
          completed={completed}
        />

        {completed ? (
          <p className="text-sm text-muted-foreground">
            {state.current_step === "verify"
              ? "Verify passed — the Workflow run finished all steps."
              : "The Workflow run is completed."}
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

        {needsHuman(state) ? (
          <NeedsHumanNotice owner={owner} repo={repo} state={state} />
        ) : null}

        {showHistory ? (
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setHistoryOpen(true)}
            >
              <History className="size-3.5" /> View history
            </Button>
          </div>
        ) : null}
      </div>
      {historyOpen ? (
        <WorkflowRunHistoryDialog
          owner={owner}
          repo={repo}
          state={state}
          onClose={() => setHistoryOpen(false)}
        />
      ) : null}
    </section>
  );
}

// The fixed Workflow steps in order, highlighting the run's current step. This reflects the run
// row's current_step only — it is not a claim that earlier steps are "complete" (that truth lives
// in `workflow step status`), so steps before the current one are shown as passed-through, not
// verified-done. A completed run marks steps up to and including current_step as past (normally
// Verify, so both); it does not force later steps to "done" if the run row completed earlier.
function StepTracker({
  currentIndex,
  currentStep,
  completed,
}: {
  currentIndex: number;
  currentStep: string;
  completed: boolean;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs">
      {STEP_ORDER.map((step, index) => {
        const isCurrent = !completed && index === currentIndex;
        const isPast =
          currentIndex >= 0 &&
          (completed ? index <= currentIndex : index < currentIndex);
        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              className={
                isCurrent
                  ? "rounded-full border border-primary-border bg-primary-subtle px-2 py-0.5 font-medium text-link"
                  : isPast
                    ? "rounded-full border border-border px-2 py-0.5 text-foreground"
                    : "rounded-full border border-border px-2 py-0.5 text-muted-foreground"
              }
              aria-current={isCurrent ? "step" : undefined}
            >
              {STEP_LABELS[step]}
            </span>
            {index < STEP_ORDER.length - 1 ? (
              <span className="text-muted-foreground">→</span>
            ) : null}
          </li>
        );
      })}
      {currentIndex < 0 && !completed ? (
        <li className="text-muted-foreground">({currentStep})</li>
      ) : null}
    </ol>
  );
}

// Needs human means the parent escalated (workflow design: parent transitions): it filed an issue
// comment summarizing the situation, sent an Inbox notification, and holds the run waiting for an
// explicit human instruction to its session (#1307). Surface the stored wait reason, point the
// human at the issue and Inbox, and add the latest Verify review summary when one exists. Legacy
// terminal `blocked` rows render the same way, minus the resumability (their parent is gone).
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
        <Link to="/inbox" className="text-link hover:underline">
          Open Inbox
        </Link>
      </div>
    </div>
  );
}
