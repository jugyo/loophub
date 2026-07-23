import type { WorkflowStep } from "./compose.ts";
import type { WorkflowStepStatuses } from "./steps.ts";

export type WorkflowReconcileInput = {
  status: string;
  currentStep: WorkflowStep;
  activeStep: WorkflowStep | null;
  needsHumanReason: string | null;
  reworkCount: number;
  currentHead: string | null;
  headAheadOfBase: boolean;
  mergeConflict: boolean;
  turnDoneForActiveExecute: boolean;
  steps: WorkflowStepStatuses;
};

export type WorkflowNextAction =
  | { action: "launch_execute"; reason: string }
  | {
      action: "advance_and_verify";
      reason: string;
      transition: "advance_to_verify" | null;
    }
  | {
      action: "request_rework";
      reason: string;
      review_id: number;
    }
  | {
      action: "deliver";
      reason: string;
      delivery_reason: "no_progress" | "merge_conflict";
    }
  | { action: "wait"; reason: string }
  | {
      action: "escalate";
      reason: string;
      escalation_reason: "rework_limit";
      review_id: number;
    }
  | {
      action: "ask_human";
      reason: string;
      question_reason: "head_unresolved";
    };

const REWORK_LIMIT = 3;

/**
 * Advise the Workflow parent about its next action from already-observed state.
 *
 * This function is deliberately side-effect free. It neither reads domain state
 * nor applies a transition; callers must use the existing lifecycle commands.
 */
export function reconcileWorkflow(
  input: WorkflowReconcileInput,
): WorkflowNextAction {
  if (input.needsHumanReason !== null) {
    return {
      action: "wait",
      reason: `Workflow is held for a human: ${input.needsHumanReason}`,
    };
  }

  if (input.status !== "running") {
    return {
      action: "wait",
      reason: `Workflow run status is ${input.status}.`,
    };
  }

  if (input.currentHead === null) {
    return {
      action: "ask_human",
      reason: "Current HEAD could not be resolved.",
      question_reason: "head_unresolved",
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
    if (input.reworkCount >= REWORK_LIMIT) {
      return {
        action: "escalate",
        reason: `Fresh review #${review.id} requests changes, but the rework limit of ${REWORK_LIMIT} has been reached.`,
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
      const transition =
        input.currentStep === "execute" ? "advance_to_verify" : null;
      return {
        action: "advance_and_verify",
        reason:
          input.currentStep === "execute"
            ? "Execute declared turn done and HEAD has advanced beyond the base and latest review."
            : "Execute declared turn done and HEAD has advanced beyond the latest review; launch a fresh Verify.",
        transition,
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
      action: "advance_and_verify",
      reason: "Verify has not started for the current HEAD.",
      transition: null,
    };
  }

  return {
    action: "wait",
    reason: "Verify is active and no fresh review is available.",
  };
}
