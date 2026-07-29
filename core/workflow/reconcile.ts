import type {
  WorkflowOutOfBandReviewWire,
  WorkflowPendingEffectReceiptWire,
  WorkflowStepStatusWire,
} from "../serialize.ts";
import type { WorkflowStep } from "./compose.ts";
import type { WorkflowStepStatuses } from "./steps.ts";

export type WorkflowReconcileInput = {
  status: string;
  /** The linked PR is closed, whether by merge or an unmerged close. */
  prClosed: boolean;
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
  /**
   * Whether a Verify child was launched after the latest Execute turn done. `activeStep` only
   * records the step activated last, so a Verify that already submitted its review stays "active"
   * while Execute keeps committing; this tells the two apart (#1857).
   */
  verifyLaunchedAfterTurnDone: boolean;
  steps: WorkflowStepStatuses;
  wake: WorkflowWakeInput | null;
};

export type WorkflowWakeInput =
  | { kind: "execute_escalation"; reason: string }
  | { kind: "github_reference"; eventId: number; references: readonly string[] }
  | { kind: "github_feedback" }
  | { kind: "diff_feedback"; threadId: number; commentId: number }
  | { kind: "out_of_band_review"; reviewId: number }
  | { kind: "cost_limit_increased" }
  | { kind: "human_instruction" }
  | { kind: "cost_exceeded"; eventId: number };

export type WorkflowNextAction =
  | { action: "complete"; reason: string }
  | { action: "launch_execute"; reason: string }
  | {
      action: "launch_verify";
      reason: string;
      transition: "resume_verify" | null;
    }
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
      // A diff comment names its own subject, so the delivery text is fixed like rework's: the
      // parent hands over the ids and Execute reads the comment itself.
      action: "deliver";
      reason: string;
      delivery_reason: "diff_feedback";
      thread_id: number;
      comment_id: number;
    }
  | {
      action: "deliver";
      reason: string;
      delivery_reason: "human_instruction" | "cost_limit_increased";
      transition: "resume_execute" | null;
    }
  | {
      // The parent reads the named GitHub resources and re-enters `next` with its verdict. The
      // action carries the canonical references only; the untrusted body stays out of the result so
      // the trust boundary — reading and judging that content — remains the parent's alone.
      action: "read_github_reference";
      reason: string;
      event_id: number;
      references: readonly string[];
    }
  | { action: "cost_hold"; reason: string; event_id: number }
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

export type WorkflowActionInstruction = {
  command: "lh" | "gh";
  args: string[];
  /** The parent supplies this value only at the explicitly named judgement boundary. */
  input?: {
    argument: "--text" | "--reason";
    source: "delivery_instruction" | "escalation_reason";
  };
};

export type WorkflowActionPlan = {
  boundary: "mechanical" | "parent_judgement" | "human_judgement";
  commands: WorkflowActionInstruction[];
  decision: null | {
    question: string;
    inputs: string[];
    submit: WorkflowActionInstruction | null;
  };
  after: "watch" | "stop";
};

/** Turn a reconciliation decision into the complete, ordered procedure returned by `next`. */
export function workflowActionPlan(
  action: WorkflowNextAction,
  context: { repo: string; run: number; issue: number },
): WorkflowActionPlan {
  const base = ["workflow"];
  const scoped = ["--repo", context.repo, "--run", String(context.run)];
  const command = (...args: string[]): WorkflowActionInstruction => ({
    command: "lh",
    args: [...base, ...args],
  });
  const watch = (
    commands: WorkflowActionInstruction[],
    boundary: WorkflowActionPlan["boundary"] = "mechanical",
  ): WorkflowActionPlan => ({
    boundary,
    commands,
    decision: null,
    after: "watch",
  });

  switch (action.action) {
    case "complete":
      return {
        boundary: "mechanical",
        commands: [],
        decision: null,
        after: "stop",
      };
    case "launch_execute":
      return watch([command("launch-step", ...scoped, "--step", "execute")]);
    case "launch_verify":
      return watch([
        ...(action.transition === "resume_verify"
          ? [command("run", "resume", ...scoped, "--step", "verify")]
          : []),
        command("launch-step", ...scoped, "--step", "verify"),
      ]);
    case "advance_and_verify":
      return watch([
        command("run", "advance-to-verify", ...scoped),
        command("launch-step", ...scoped, "--step", "verify"),
      ]);
    case "request_rework":
      return watch([
        command(
          "run",
          "request-rework",
          ...scoped,
          "--review",
          String(action.review_id),
        ),
        command(
          "deliver",
          ...scoped,
          "--text",
          `orchestrator: address review #${action.review_id}`,
        ),
      ]);
    case "deliver": {
      if (action.delivery_reason === "diff_feedback") {
        return watch([
          command(
            "deliver",
            ...scoped,
            "--text",
            `orchestrator: address diff feedback thread #${action.thread_id} comment #${action.comment_id}`,
          ),
        ]);
      }
      const deliver = command("deliver", ...scoped);
      deliver.input = {
        argument: "--text",
        source: "delivery_instruction",
      };
      return watch(
        [
          ...("transition" in action && action.transition === "resume_execute"
            ? [command("run", "resume", ...scoped, "--step", "execute")]
            : []),
          deliver,
        ],
        "parent_judgement",
      );
    }
    case "read_github_reference":
      return {
        boundary: "parent_judgement",
        commands: action.references.map((reference) => ({
          command: "gh",
          args: ["api", reference],
        })),
        decision: {
          question:
            "Do the referenced GitHub resources require Execute changes?",
          inputs: [...action.references],
          submit: command(
            "next",
            String(context.run),
            "--repo",
            context.repo,
            "--event",
            String(action.event_id),
            "--requires-changes",
            "<true|false>",
            "--json",
          ),
        },
        after: "watch",
      };
    case "cost_hold":
      return watch([
        command("cost-hold", ...scoped, "--event", String(action.event_id)),
      ]);
    case "wait":
      return watch([]);
    case "escalate": {
      const escalate = command(
        "escalate-human",
        ...scoped,
        "--issue",
        String(context.issue),
      );
      escalate.input = {
        argument: "--reason",
        source: "escalation_reason",
      };
      return watch([escalate], "parent_judgement");
    }
    case "ask_human":
      return {
        boundary: "human_judgement",
        commands: [],
        decision: {
          question: action.reason,
          inputs: ["human answer"],
          submit: command(
            "next",
            String(context.run),
            "--repo",
            context.repo,
            "--note",
            "<human answer>",
            "--json",
          ),
        },
        after: "stop",
      };
  }
}

export const WORKFLOW_REWORK_LIMIT = 8;

/**
 * Advise the Workflow parent about its next action from already-observed state.
 *
 * This function is deliberately side-effect free. It neither reads domain state
 * nor applies a transition; callers must use the existing lifecycle commands.
 */
export function reconcileWorkflow(
  input: WorkflowReconcileInput,
): WorkflowNextAction {
  // A merged or closed PR is terminal, so it outranks every other observation: a pending receipt,
  // a human hold, or an unaddressed review can no longer change the run. A fresh pass alone is
  // deliberately not terminal — the run keeps accepting work while the PR is open.
  if (input.prClosed) {
    return {
      action: "complete",
      reason: "The linked pull request is closed; the run is complete.",
    };
  }

  // A cost interrupt outranks every non-terminal observation, including an established hold: the
  // detection re-emits while the parent is away (#1844), so a drained replay must still reach
  // `cost-hold`. Its (run, limit) receipt — not this decision — is what keeps the effects one-time.
  if (input.wake?.kind === "cost_exceeded") {
    return {
      action: "cost_hold",
      reason: "The run exceeded its cost limit and must be held for a human.",
      event_id: input.wake.eventId,
    };
  }

  if (input.pendingEffectReceipt !== null) {
    return {
      action: "wait",
      reason: `Effect "${input.pendingEffectReceipt.effect}" for event #${input.pendingEffectReceipt.event_id} has a pending receipt.`,
    };
  }

  if (input.awaitingHuman) {
    // A run still held when its increase lands was raised by someone other than this parent — the
    // Issue Web UI (#1828). The increase is that human's continuation decision, so resume the step
    // the cost hold interrupted. A parent that increased the limit itself already resumed, so its
    // own wake falls through to the state rules below instead of resuming twice.
    if (input.wake?.kind === "cost_limit_increased") {
      if (input.costLimitIncreaseRequired) {
        return {
          action: "wait",
          reason:
            "The cost limit increased, but the new limit is already exceeded.",
        };
      }
      if (input.activeStep === "execute") {
        return {
          action: "deliver",
          reason:
            "A human increased the cost limit; Execute must re-check domain state and continue.",
          delivery_reason: "cost_limit_increased",
          transition: "resume_execute",
        };
      }
      if (input.activeStep === "verify") {
        return {
          action: "launch_verify",
          reason:
            "A human increased the cost limit; launch a fresh Verify for the interrupted step.",
          transition: "resume_verify",
        };
      }
      return {
        action: "wait",
        reason:
          "The cost limit increased, but the run has no interrupted step to resume.",
      };
    }
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

  if (input.wake?.kind === "github_reference") {
    return {
      action: "read_github_reference",
      reason:
        "GitHub feedback arrived; read the references and decide whether they require Execute work.",
      event_id: input.wake.eventId,
      references: input.wake.references,
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

  // One diff comment produces one run event, and `next --watch` spends a wake exactly once, so the
  // comment is handed to Execute once. Nothing here re-scans open threads: an undelivered comment
  // is visible on the PR and a human can post it again, which is cheaper than a redelivery rule
  // that also has to decide when a thread stops being new work.
  if (input.wake?.kind === "diff_feedback") {
    return {
      action: "deliver",
      reason: `Diff feedback conversation #${input.wake.threadId} has a new comment for Execute.`,
      delivery_reason: "diff_feedback",
      thread_id: input.wake.threadId,
      comment_id: input.wake.commentId,
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

  // Waiting is only right while the active Verify was launched for the latest turn done. When
  // Execute has committed again since that launch, no child is reviewing the current HEAD, so
  // waiting here would wedge the run forever (#1857) — fall through to the turn done branch.
  if (
    input.currentStep === "verify" &&
    input.activeStep === "verify" &&
    input.verifyLaunchedAfterTurnDone
  ) {
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
            transition: null,
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
      transition: null,
    };
  }

  return {
    action: "wait",
    reason: "Verify is active and no fresh review is available.",
  };
}
