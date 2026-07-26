// Shared Execute → Verify → Done step tracker for a workflow run. Rendered both compact in a PR list
// row (LinkedPullSummaryRow) and larger in the issue / PR detail Workflow run section
// (workflow-run-status.tsx). An optional workflow root icon connects to the stage pills; hovering it
// exposes the parent/orchestrator pane action. The current stage is colored, the rest are grey, and
// traversed connectors fill in to convey progression.
//
// `execute` / `verify` are the run's real steps; "Done" is the terminal reached when Verify passes
// (`verification_status: verified`) — NOT `status === completed`, which a passing Verify never sets
// (#1401 / #1460); that status means the linked PR merged (#1808). A stale verification keeps the
// Verify label as-is and is conveyed by the pill's amber tone plus its popover status (#1906); a
// needs-human run (#1307, or a legacy `blocked` row) appends a warning marker unless the caller
// already says why with its own "over budget" marker (#1932).

import {
  Check,
  Loader2,
  Terminal,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { HerdrAgent, HerdrSessions, WorkflowRunState } from "@/api/types";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { useHoverPopover } from "@/lib/use-hover-popover";
import { cn } from "@/lib/utils";
import { useFocusHerdrAgent } from "@/queries/terminal";

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

type WorkflowStage = (typeof STAGES)[number];

function latestWorkflowStepAgent(
  sessions: HerdrSessions | undefined,
  repo: string | undefined,
  runId: number,
  step: "execute" | "verify",
): HerdrAgent | undefined {
  if (!repo) return undefined;
  const agents =
    sessions?.repos?.find((candidate) => candidate.repo === repo)?.agents ?? [];
  let latest: HerdrAgent | undefined;
  let latestSequence = -1;
  for (const agent of agents) {
    if (
      !agent.focusable ||
      agent.workflow?.kind !== "step" ||
      agent.workflow.runId !== runId ||
      agent.workflow.step !== step ||
      agent.workflow.sequence < latestSequence
    ) {
      continue;
    }
    latest = agent;
    latestSequence = agent.workflow.sequence;
  }
  return latest;
}

function workflowParentAgent(
  sessions: HerdrSessions | undefined,
  repo: string | undefined,
  runId: number,
): HerdrAgent | undefined {
  if (!repo) return undefined;
  const agents =
    sessions?.repos?.find((candidate) => candidate.repo === repo)?.agents ?? [];
  return agents.find(
    (agent) =>
      agent.focusable &&
      agent.workflow?.kind === "parent" &&
      agent.workflow.runId === runId,
  );
}

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
  conflict: boolean,
): string {
  if (conflict) {
    return "Merge conflict — resolve it before this PR can merge";
  }
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

function OpenInHerdrButton({
  repo,
  agent,
}: {
  repo: string;
  agent: HerdrAgent;
}) {
  const focus = useFocusHerdrAgent();
  const { showError } = useToast();
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="shrink-0"
      aria-label="Open in Herdr"
      title="Open in Herdr"
      disabled={focus.isPending}
      onClick={() =>
        focus.mutate(
          { repo, paneId: agent.id },
          {
            onError: (error) =>
              showError(
                error instanceof Error
                  ? error.message
                  : "Failed to open in Herdr.",
              ),
          },
        )
      }
    >
      {focus.isPending ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Terminal className="size-3.5" aria-hidden="true" />
      )}
      Open in Herdr
    </Button>
  );
}

function WorkflowNode({
  state,
  stateSummary,
  repo,
  agent,
  herdrUnavailable,
  onInteract,
  size,
}: {
  state: WorkflowRunState;
  stateSummary: string;
  repo?: string;
  agent?: HerdrAgent;
  herdrUnavailable?: boolean;
  onInteract?: () => void;
  size: "sm" | "md";
}) {
  const popover = useHoverPopover();
  const dialogId = `workflow-run-${state.id}-details`;

  return (
    <div
      data-workflow-node
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
      <button
        type="button"
        aria-label="Workflow"
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-controls={popover.open ? dialogId : undefined}
        className={cn(
          "flex items-center justify-center rounded-full border border-border bg-muted text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          size === "md" ? "size-6" : "size-[18px]",
        )}
      >
        <Workflow
          className={size === "md" ? "size-3.5" : "size-2.5"}
          aria-hidden="true"
        />
      </button>
      {popover.open ? (
        <div className="absolute left-0 top-full z-30 w-56 pt-1">
          <div
            id={dialogId}
            role="dialog"
            aria-label="Workflow details"
            className="rounded-md border bg-background p-3 text-foreground shadow-lg"
          >
            <div className="border-b pb-2">
              <div className="truncate text-sm font-semibold">
                {state.workflow_name ?? "Workflow"}
              </div>
              <div className="text-xs text-muted-foreground">
                Run #{state.id}
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-[3.5rem_1fr] gap-x-2 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-medium">{agent?.status ?? state.status}</dd>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">{stateSummary}</p>
            {herdrUnavailable ? (
              <p className="mt-2 text-xs text-destructive">
                Herdr pane data is unavailable.
              </p>
            ) : null}
            {repo && agent ? (
              <div className="mt-2 flex justify-end border-t pt-2">
                <OpenInHerdrButton repo={repo} agent={agent} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WorkflowStagePill({
  stage,
  runId,
  stateSummary,
  stageStatus,
  ariaCurrent,
  className,
  repo,
  agent,
  herdrUnavailable,
  onInteract,
  children,
}: {
  stage: WorkflowStage;
  runId: number;
  stateSummary: string;
  stageStatus: string;
  ariaCurrent?: "step";
  className: string;
  repo?: string;
  agent?: HerdrAgent;
  herdrUnavailable?: boolean;
  onInteract?: () => void;
  children: ReactNode;
}) {
  const popover = useHoverPopover();
  const dialogId = `workflow-run-${runId}-${stage.key}-details`;
  const alignment =
    stage.key === "execute"
      ? "left-0"
      : stage.key === "done"
        ? "right-0"
        : "left-1/2 -translate-x-1/2";

  return (
    <div
      data-workflow-stage={stage.key}
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
        aria-current={ariaCurrent}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-controls={popover.open ? dialogId : undefined}
        className={cn(
          className,
          "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        )}
      >
        {children}
      </span>
      {popover.open ? (
        <div className={cn("absolute top-full z-30 w-56 pt-1", alignment)}>
          <div
            id={dialogId}
            role="dialog"
            aria-label={`${stage.label} workflow step details`}
            className="rounded-md border bg-background p-3 text-foreground shadow-lg"
          >
            <div className="flex items-start gap-3 border-b pb-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold">{stage.label} step</div>
                <div className="text-xs text-muted-foreground">
                  Run #{runId}
                </div>
              </div>
            </div>
            <dl className="mt-2 grid grid-cols-[3.5rem_1fr] gap-x-2 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-medium">{stageStatus}</dd>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">{stateSummary}</p>
            {herdrUnavailable ? (
              <p className="mt-2 text-xs text-destructive">
                Herdr pane data is unavailable.
              </p>
            ) : null}
            {repo && agent ? (
              <div className="mt-2 flex justify-end border-t pt-2">
                <OpenInHerdrButton repo={repo} agent={agent} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkflowStepTracker({
  owner,
  repo,
  state,
  herdrSessions,
  herdrUnavailable = false,
  onStageInteract,
  showWorkflowNode = false,
  size = "sm",
  working = false,
  conflict = false,
  overBudget = false,
}: {
  owner?: string;
  repo?: string;
  state: WorkflowRunState;
  /** Worker-owned Herdr snapshot used to resolve this run's step panes. */
  herdrSessions?: HerdrSessions;
  /** Herdr snapshot acquisition failed, so pane actions cannot be resolved safely. */
  herdrUnavailable?: boolean;
  /** Lets a containing resource popover yield while a step popup is active. */
  onStageInteract?: () => void;
  /** Show the workflow/orchestrator root before Execute in compact linked-PR rows. */
  showWorkflowNode?: boolean;
  /** `sm` for the compact PR-row tracker, `md` for the detail Workflow run section. */
  size?: "sm" | "md";
  /**
   * When the linked agent is actively working, gently glow the current stage pill so the
   * run reads as live at a glance. Defaults to `false`, so callers that omit it keep the
   * previous static rendering.
   */
  working?: boolean;
  /**
   * PR-level merge conflict (`mergeable_state === "conflict"`), which the run's
   * {@link WorkflowRunState} does not carry. When set, the terminal "Done" pill flips to a
   * danger-toned "Conflict!" so the row/section reads as un-mergeable at a glance (#1659).
   * Defaults to `false`, keeping the plain Execute → Verify → Done pipeline.
   */
  conflict?: boolean;
  /**
   * The run is held on its cost limit and the caller renders its own "over budget" marker. Such a
   * run is always needs-human, so the trailing "needs human" marker would repeat the same warning
   * in less specific words — drop it and let the budget marker speak (#1932). The stage popovers
   * still report the needs-human status. Defaults to `false`, keeping the marker.
   */
  overBudget?: boolean;
}) {
  const tracker = workflowTrackerState(state);
  const { activeIndex, verified, stale, needsHuman } = tracker;
  const pillSize =
    size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]";
  const connectorSize = size === "md" ? "w-4" : "w-2.5";
  const repoFullName = owner && repo ? `${owner}/${repo}` : undefined;
  const stateSummary = workflowTrackerTitle(state, tracker, conflict);
  const parentAgent = workflowParentAgent(
    herdrUnavailable ? undefined : herdrSessions,
    repoFullName,
    state.id,
  );
  return (
    <div
      data-debug-component="WorkflowStepTracker"
      data-workflow-step-tracker
      className="flex min-w-0 shrink-0 items-center gap-1"
      aria-label={stateSummary}
    >
      {showWorkflowNode ? (
        <>
          <WorkflowNode
            state={state}
            stateSummary={stateSummary}
            repo={repoFullName}
            agent={parentAgent}
            herdrUnavailable={herdrUnavailable}
            onInteract={onStageInteract}
            size={size}
          />
          <span
            data-workflow-connector="workflow-execute"
            aria-hidden="true"
            className={cn("h-px rounded-full bg-primary-border", connectorSize)}
          />
        </>
      ) : null}
      {STAGES.map((stage, index) => {
        const isCurrent = index === activeIndex;
        const isPast = index < activeIndex;
        // A PR-level conflict wins the terminal pill regardless of the run's step: an un-mergeable
        // PR is the most actionable state to surface, so "Done" becomes "Conflict!" (#1659).
        const isDoneConflict = stage.key === "done" && conflict;
        const isDoneVerified = stage.key === "done" && verified && !conflict;
        const isStaleVerify = stage.key === "verify" && isCurrent && stale;
        const stageStatus = isDoneConflict
          ? "Conflict"
          : isStaleVerify
            ? "Reverify required"
            : isDoneVerified
              ? "Reached"
              : isCurrent
                ? needsHuman
                  ? "Needs human"
                  : "Current"
                : isPast
                  ? "Completed"
                  : "Upcoming";
        const agent =
          stage.key === "done"
            ? undefined
            : latestWorkflowStepAgent(
                herdrSessions,
                repoFullName,
                state.id,
                stage.key,
              );
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
            <WorkflowStagePill
              stage={stage}
              runId={state.id}
              stateSummary={stateSummary}
              stageStatus={stageStatus}
              ariaCurrent={isCurrent ? "step" : undefined}
              repo={repoFullName}
              agent={agent}
              herdrUnavailable={herdrUnavailable && stage.key !== "done"}
              onInteract={onStageInteract}
              className={cn(
                "flex items-center gap-1 whitespace-nowrap rounded-full border font-medium leading-none",
                pillSize,
                isDoneConflict
                  ? "border-red-600/40 bg-red-600/10 text-red-700 dark:text-red-400"
                  : isStaleVerify
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : isDoneVerified
                      ? "border-green-600/40 bg-green-600/10 text-green-700 dark:text-green-400"
                      : isCurrent
                        ? "border-primary-border bg-primary-subtle text-link"
                        : isPast
                          ? "border-border bg-muted text-foreground"
                          : "border-border text-muted-foreground",
                // Done is a terminal, not an active step — never glow it, even while working.
                isCurrent &&
                  working &&
                  stage.key !== "done" &&
                  "animate-[workflow-stage-glow_2.4s_ease-in-out_infinite]",
              )}
            >
              {isDoneConflict ? (
                <TriangleAlert className="size-3" aria-hidden="true" />
              ) : isDoneVerified ? (
                <Check className="size-3" aria-hidden="true" />
              ) : null}
              {isDoneConflict ? "Conflict!" : stage.label}
            </WorkflowStagePill>
          </Fragment>
        );
      })}
      {needsHuman && !overBudget ? (
        <span className="flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-amber-700 dark:text-amber-300">
          <TriangleAlert className="size-3" aria-hidden="true" />
          needs human
        </span>
      ) : null}
    </div>
  );
}
