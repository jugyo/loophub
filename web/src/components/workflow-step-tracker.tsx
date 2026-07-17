// Shared Execute → Verify → Done step tracker for a workflow run. Rendered both compact in a PR list
// row (LinkedPullSummaryRow) and larger in the issue / PR detail Workflow run section
// (workflow-run-status.tsx). The stages are pills joined by connector lines: the current stage is
// colored, the rest are grey, and traversed connectors fill in to convey progression.
//
// `execute` / `verify` are the run's real steps; "Done" is the terminal reached when Verify passes
// (`verification_status: verified`) — NOT `status === completed`, which the automatic flow never sets
// after Verify passes (#1401 / #1460). A stale verification annotates Verify with "reverify"; a
// needs-human run (#1307, or a legacy `blocked` row) appends a warning marker.

import { TriangleAlert } from "lucide-react";
import { Fragment } from "react";
import type { WorkflowRunState } from "@/api/types";
import { cn } from "@/lib/utils";

const STAGES = [
  { key: "execute", label: "Execute" },
  { key: "verify", label: "Verify" },
  { key: "done", label: "Done" },
] as const;

type WorkflowTrackerState = {
  activeIndex: number;
  verified: boolean;
  stale: boolean;
  needsHuman: boolean;
};

export function workflowTrackerState(
  state: WorkflowRunState,
): WorkflowTrackerState {
  const needsHuman =
    (state.status === "running" && state.needs_human_reason !== null) ||
    state.status === "blocked";
  const verified =
    state.status === "running" &&
    state.needs_human_reason === null &&
    state.verification_status === "verified";
  const stale =
    state.status === "running" &&
    state.needs_human_reason === null &&
    state.verification_status === "stale";
  // Verify pass advances the tracker to Done (index 2); otherwise it sits on the run's current step.
  const stepIndex = state.current_step === "verify" ? 1 : 0;
  const activeIndex = verified ? 2 : stepIndex;
  return { activeIndex, verified, stale, needsHuman };
}

function workflowTrackerTitle(
  state: WorkflowRunState,
  { verified, stale, needsHuman }: WorkflowTrackerState,
): string {
  if (needsHuman) {
    return "Workflow run is waiting for a human instruction";
  }
  if (verified) {
    return "Verify passed for the current HEAD — the run reached Done";
  }
  if (stale) {
    return "HEAD changed after Verify passed — a fresh Verify is required";
  }
  return `Workflow step: ${state.current_step === "verify" ? "Verify" : "Execute"}`;
}

export function WorkflowStepTracker({
  state,
  size = "sm",
}: {
  state: WorkflowRunState;
  /** `sm` for the compact PR-row tracker, `md` for the detail Workflow run section. */
  size?: "sm" | "md";
}) {
  const tracker = workflowTrackerState(state);
  const { activeIndex, verified, stale, needsHuman } = tracker;
  const pillSize =
    size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]";
  const connectorSize = size === "md" ? "w-4" : "w-2.5";
  return (
    <div
      data-workflow-step-tracker
      className="flex min-w-0 shrink-0 items-center gap-1"
      title={workflowTrackerTitle(state, tracker)}
    >
      {STAGES.map((stage, index) => {
        const isCurrent = index === activeIndex;
        const isPast = index < activeIndex;
        const isDoneVerified = stage.key === "done" && verified;
        const isStaleVerify = stage.key === "verify" && isCurrent && stale;
        return (
          <Fragment key={stage.key}>
            {index > 0 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "h-px rounded-full",
                  connectorSize,
                  // Fill the connectors already traversed so the pipeline reads as progressing.
                  index <= activeIndex ? "bg-primary-border" : "bg-border",
                )}
              />
            ) : null}
            <span
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex items-center gap-1 whitespace-nowrap rounded-full border font-medium leading-none",
                pillSize,
                isStaleVerify
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : isDoneVerified
                    ? "border-green-600/40 bg-green-600/10 text-green-700 dark:text-green-400"
                    : isCurrent
                      ? "border-primary-border bg-primary-subtle text-link"
                      : isPast
                        ? "border-border bg-muted text-foreground"
                        : "border-border text-muted-foreground",
              )}
            >
              {stage.label}
              {isStaleVerify ? (
                <span className="font-normal">· reverify</span>
              ) : null}
            </span>
          </Fragment>
        );
      })}
      {needsHuman ? (
        <span className="flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-amber-700 dark:text-amber-300">
          <TriangleAlert className="size-3" aria-hidden="true" />
          needs human
        </span>
      ) : null}
    </div>
  );
}
