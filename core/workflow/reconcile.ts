import type {
  WorkflowOutOfBandReviewWire,
  WorkflowPendingEffectReceiptWire,
  WorkflowStepStatusWire,
} from "../serialize.ts";
import type { WorkflowStep } from "./compose.ts";
import type { WorkflowStepStatuses } from "./steps.ts";

export type WorkflowReconcileInput = {
  status: string;
  /** The linked PR's domain state is merged — the run's terminal condition (#1808). */
  prMerged: boolean;
  currentStep: WorkflowStep;
  activeStep: WorkflowStep | null;
  needsHumanReason: WorkflowStepStatusWire["needs_human_reason"];
  awaitingHuman: WorkflowStepStatusWire["awaiting_human"];
  costLimitIncreaseRequired: boolean;
  reworkCount: WorkflowStepStatusWire["rework_count"];
  reworkLimit: WorkflowStepStatusWire["rework_limit"];
  pendingEffectReceipt: WorkflowPendingEffectReceiptWire | null;
  unaddressedOutOfBandReviews: WorkflowOutOfBandReviewWire[];
  currentHead: string | null;
  mergeConflict: boolean;
  turnDoneForActiveExecute: boolean;
  steps: WorkflowStepStatuses;
  wake: WorkflowWakeInput | null;
};

export type WorkflowWakeInput =
  | { kind: "execute_escalation"; reason: string }
  | { kind: "github_feedback" }
  | { kind: "out_of_band_review"; reviewId: number }
  | { kind: "human_instruction" };

export type WorkflowNextAction =
  | { action: "complete"; reason: string }
  | { action: "launch_execute"; reason: string }
  | { action: "launch_verify"; reason: string }
  | { action: "advance_and_verify"; reason: string }
  | {
      action: "request_rework";
      reason: string;
      review_id: number;
    }
  | {
      action: "deliver";
      reason: string;
      delivery_reason: "no_progress" | "merge_conflict" | "github_feedback";
    }
  | {
      action: "deliver";
      reason: string;
      delivery_reason: "out_of_band_review";
      review_id: number;
    }
  | {
      action: "deliver";
      reason: string;
      delivery_reason: "human_instruction";
      transition: "resume_execute" | null;
    }
  | { action: "wait"; reason: string }
  | {
      action: "escalate";
      reason: string;
      escalation_reason: "rework_limit";
      review_id: number;
    }
  | {
      action: "escalate";
      reason: string;
      escalation_reason: "execute_request";
    }
  | {
      action: "ask_human";
      reason: string;
      question_reason: "head_unresolved";
    };

export const WORKFLOW_REWORK_LIMIT = 3;

/**
 * Advise the Workflow parent about its next action from already-observed state.
 *
 * This function is deliberately side-effect free. It neither reads domain state
 * nor applies a transition; callers must use the existing lifecycle commands.
 */
export function reconcileWorkflow(
  input: WorkflowReconcileInput,
): WorkflowNextAction {
  // A merged PR is the only terminal condition (#1808), so it outranks every other observation: a
  // pending receipt, a human hold, or an unaddressed review can no longer change what shipped. A
  // fresh pass alone is deliberately not terminal — the run keeps accepting work while the PR is
  // open.
  if (input.prMerged) {
    return {
      action: "complete",
      reason: "The linked pull request is merged; the run is complete.",
    };
  }

  if (input.pendingEffectReceipt !== null) {
    return {
      action: "wait",
      reason: `Effect "${input.pendingEffectReceipt.effect}" for event #${input.pendingEffectReceipt.event_id} has a pending receipt.`,
    };
  }

  if (input.awaitingHuman) {
    if (input.wake?.kind === "human_instruction") {
      if (input.costLimitIncreaseRequired) {
        return {
          action: "wait",
          reason:
            "Workflow is held because its cost limit must be increased before resuming.",
        };
      }
      return {
        action: "deliver",
        reason: "A human supplied additional work for Execute.",
        delivery_reason: "human_instruction",
        transition: "resume_execute",
      };
    }
    return {
      action: "wait",
      reason: `Workflow is held for a human: ${input.needsHumanReason ?? "reason unavailable"}`,
    };
  }

  if (input.status !== "running") {
    return {
      action: "wait",
      reason: `Workflow run status is ${input.status}.`,
    };
  }

  if (input.wake?.kind === "execute_escalation") {
    return {
      action: "escalate",
      reason: input.wake.reason,
      escalation_reason: "execute_request",
    };
  }

  if (input.wake?.kind === "github_feedback") {
    return {
      action: "deliver",
      reason:
        "Parent evaluation found GitHub feedback that requires Execute work.",
      delivery_reason: "github_feedback",
    };
  }

  if (input.wake?.kind === "out_of_band_review") {
    return {
      action: "deliver",
      reason: `Out-of-band review #${input.wake.reviewId} requires Execute work.`,
      delivery_reason: "out_of_band_review",
      review_id: input.wake.reviewId,
    };
  }

  if (input.wake?.kind === "human_instruction") {
    return {
      action: "deliver",
      reason: "A human supplied additional work for Execute.",
      delivery_reason: "human_instruction",
      transition: null,
    };
  }

  if (input.currentHead === null) {
    return {
      action: "ask_human",
      reason: "Current HEAD could not be resolved.",
      question_reason: "head_unresolved",
    };
  }

  const outOfBandReview = input.unaddressedOutOfBandReviews[0];
  if (outOfBandReview) {
    return {
      action: "deliver",
      reason: `Out-of-band review #${outOfBandReview.id} (${outOfBandReview.verdict}) has not been addressed.`,
      delivery_reason: "out_of_band_review",
      review_id: outOfBandReview.id,
    };
  }

  if (input.mergeConflict) {
    return {
      action: "deliver",
      reason: "Current HEAD conflicts with the base branch.",
      delivery_reason: "merge_conflict",
    };
  }

  const review = input.steps.verify.latest_review;
  if (
    input.currentStep === "verify" &&
    review?.fresh &&
    review.event === "request_changes"
  ) {
    if (input.reworkCount >= input.reworkLimit) {
      return {
        action: "escalate",
        reason: `Fresh review #${review.id} requests changes, but the rework limit of ${input.reworkLimit} has been reached.`,
        escalation_reason: "rework_limit",
        review_id: review.id,
      };
    }
    return {
      action: "request_rework",
      reason: `Fresh review #${review.id} requests changes.`,
      review_id: review.id,
    };
  }

  if (
    input.currentStep === "verify" &&
    review?.fresh &&
    review.event === "pass"
  ) {
    return {
      action: "wait",
      reason: `Fresh review #${review.id} passes the current HEAD.`,
    };
  }

  if (input.currentStep === "verify" && input.activeStep === "verify") {
    return {
      action: "wait",
      reason: "Verify is active and no fresh review is available.",
    };
  }

  if (input.turnDoneForActiveExecute) {
    if (input.steps.execute.complete) {
      return input.currentStep === "execute"
        ? {
            action: "advance_and_verify",
            reason:
              "Execute declared turn done and HEAD has advanced beyond the base and latest review.",
          }
        : {
            action: "launch_verify",
            reason:
              "Execute declared turn done and HEAD has advanced beyond the latest review; launch a fresh Verify.",
          };
    }
    return {
      action: "deliver",
      reason:
        input.currentStep === "execute"
          ? "Execute declared turn done, but HEAD has not advanced beyond the base or latest review."
          : "Execute declared turn done, but HEAD has not advanced beyond the latest review.",
      delivery_reason: "no_progress",
    };
  }

  if (input.currentStep === "execute") {
    if (input.activeStep !== "execute") {
      return {
        action: "launch_execute",
        reason: "Execute has not started.",
      };
    }
    return {
      action: "wait",
      reason: "Execute is active and has not declared turn done.",
    };
  }

  if (input.activeStep === "execute") {
    return {
      action: "wait",
      reason: "Execute is active and has not declared turn done.",
    };
  }

  if (input.activeStep !== "verify") {
    return {
      action: "launch_verify",
      reason: "Verify has not started for the current HEAD.",
    };
  }

  return {
    action: "wait",
    reason: "Verify is active and no fresh review is available.",
  };
}
