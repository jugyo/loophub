import type { WorkflowFinding, WorkflowVerdictArtifact } from "./artifacts.ts";
import type { WorkflowStep } from "./compose.ts";

/**
 * State of the latest validated artifact of one type, as seen by the completion
 * query. `headSha` is the SHA the engine stamped at submission (workflow design:
 * artifact model); `placed`
 * is whether that latest artifact has a placement record (`workflow_placements`).
 * An accepted-but-unplaced artifact is `placed: false` and therefore
 * never completes its step.
 */
export type WorkflowLatestArtifactState = {
  headSha: string;
  placed: boolean;
};

/**
 * Pure inputs for {@link evaluateWorkflowSteps}. Everything is resolved by the
 * caller from `workflow_artifacts` × `workflow_placements` × the worktree head — this
 * function reads no DB / fs and knows nothing about PR body / comment markers.
 */
export type WorkflowStepEvalInput = {
  /** Current worktree HEAD, or null when it could not be resolved. */
  currentHead: string | null;
  /** Whether HEAD is ahead of the run's base branch. */
  headAheadOfBase: boolean;
  /** Latest validated `execution-report` artifact state. */
  execute: WorkflowLatestArtifactState | null;
  /** Latest validated `verdict` artifact state. */
  verify: WorkflowLatestArtifactState | null;
  /** Parsed content of the latest verdict artifact (for the rework summary). */
  latestVerdict: WorkflowVerdictArtifact | null;
};

export type WorkflowStepStatus = {
  complete: boolean;
  missing: string[];
};

export type WorkflowLatestVerdictSummary = {
  event: "pass" | "request_changes";
  summary: string;
  findings: WorkflowFinding[];
};

export type WorkflowStepStatuses = {
  execute: WorkflowStepStatus;
  verify: WorkflowStepStatus & {
    latest_verdict: WorkflowLatestVerdictSummary | null;
  };
};

function placedAtHead(
  state: WorkflowLatestArtifactState | null,
  currentHead: string | null,
): boolean {
  return Boolean(
    state?.placed && currentHead !== null && state.headSha === currentHead,
  );
}

/**
 * Evaluate the completion condition of each Workflow step (workflow design:
 * completion conditions) as a pure query.
 *
 * - Execute completes when a validated execution-report is placed, its stamped
 *   SHA equals the current head, and the head is ahead of base.
 * - Verify completes when a validated verdict is placed and its stamped SHA
 *   equals the current head.
 *
 * Because Execute / Verify compare the stamped SHA to the current head, moving
 * the head forward turns a previously complete step back to incomplete (stale).
 */
export function evaluateWorkflowSteps(
  input: WorkflowStepEvalInput,
): WorkflowStepStatuses {
  const executeMissing: string[] = [];
  if (!placedAtHead(input.execute, input.currentHead)) {
    executeMissing.push("no validated execution-report for current head");
  }
  if (!input.headAheadOfBase) {
    executeMissing.push("head equals base");
  }
  const execute: WorkflowStepStatus = {
    complete: executeMissing.length === 0,
    missing: executeMissing,
  };

  const verifyComplete = placedAtHead(input.verify, input.currentHead);
  const verify: WorkflowStepStatus & {
    latest_verdict: WorkflowLatestVerdictSummary | null;
  } = {
    complete: verifyComplete,
    missing: verifyComplete ? [] : ["no validated verdict for current head"],
    latest_verdict: input.latestVerdict
      ? {
          event: input.latestVerdict.event,
          summary: input.latestVerdict.summary,
          findings: input.latestVerdict.findings,
        }
      : null,
  };

  return { execute, verify };
}

export const WORKFLOW_STEP_ORDER: readonly WorkflowStep[] = [
  "execute",
  "verify",
];
