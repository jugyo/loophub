import type { WorkflowStep } from "./compose.ts";

/**
 * The latest Verify review observed for a run: the run's own verifier child's
 * PR review, pinned to the head SHA it reviewed. This is a
 * plain domain fact — there is no Workflow-specific completion state behind it.
 */
export type WorkflowLatestReviewState = {
  id: number;
  event: "pass" | "request_changes";
  headSha: string | null;
};

/**
 * Pure inputs for {@link evaluateWorkflowSteps}. Everything is resolved by the
 * caller from the worktree head and the PR's reviews — this function reads no
 * DB / fs. Verification freshness is derived only from comparing the review's
 * pinned head SHA to the current HEAD; no dedicated freshness state exists.
 */
export type WorkflowStepEvalInput = {
  /** Current worktree HEAD, or null when it could not be resolved. */
  currentHead: string | null;
  /** Whether HEAD is ahead of the run's base branch. */
  headAheadOfBase: boolean;
  /** Whether the latest reviewed SHA is an ancestor of current HEAD. */
  headAheadOfLatestReview: boolean;
  /** Latest review submitted by this run's Verify children, or null. */
  latestReview: WorkflowLatestReviewState | null;
};

export type WorkflowStepStatus = {
  complete: boolean;
  missing: string[];
};

export type WorkflowLatestReviewSummary = WorkflowLatestReviewState & {
  /** Whether the review is pinned to the current HEAD. */
  fresh: boolean;
};

export type WorkflowStepStatuses = {
  execute: WorkflowStepStatus;
  verify: WorkflowStepStatus & {
    latest_review: WorkflowLatestReviewSummary | null;
  };
};

function reviewIsFresh(
  review: WorkflowLatestReviewState | null,
  currentHead: string | null,
): boolean {
  return Boolean(
    review?.headSha && currentHead !== null && review.headSha === currentHead,
  );
}

/**
 * Evaluate each Workflow step's observable state as a pure query over the
 * domain: the worktree HEAD and the run's latest Verify review.
 *
 * - Execute is complete when HEAD is ahead of base and has advanced past the
 *   latest reviewed SHA (there is new work to verify). A turn-done declaration
 *   is a timing signal, never part of this truth.
 * - Verify is complete when the latest review is pinned to the current HEAD.
 *
 * Review progress is an ancestry relation, not mere SHA inequality: rewinding
 * or moving to a diverged HEAD makes a review stale without completing Execute.
 */
export function evaluateWorkflowSteps(
  input: WorkflowStepEvalInput,
): WorkflowStepStatuses {
  const fresh = reviewIsFresh(input.latestReview, input.currentHead);

  const executeMissing: string[] = [];
  if (!input.headAheadOfBase) {
    executeMissing.push("head equals base");
  }
  if (input.latestReview && !input.headAheadOfLatestReview) {
    executeMissing.push(
      `head has not advanced past review #${input.latestReview.id} (${input.latestReview.event})`,
    );
  }
  const execute: WorkflowStepStatus = {
    complete: executeMissing.length === 0,
    missing: executeMissing,
  };

  const verify: WorkflowStepStatuses["verify"] = {
    complete: fresh,
    missing: fresh ? [] : ["no workflow review pinned to current head"],
    latest_review: input.latestReview ? { ...input.latestReview, fresh } : null,
  };

  return { execute, verify };
}

export const WORKFLOW_STEP_ORDER: readonly WorkflowStep[] = [
  "execute",
  "verify",
];
