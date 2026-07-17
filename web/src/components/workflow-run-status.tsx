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
import { WorkflowStepTracker } from "@/components/workflow-step-tracker";

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

        <WorkflowStepTracker state={state} size="md" />

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
