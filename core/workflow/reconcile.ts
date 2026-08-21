import type {
  WorkflowOutOfBandReviewWire,
  WorkflowPendingEffectReceiptWire,
  WorkflowStepStatusWire,
} from "../serialize.ts";
import type { WorkflowCommentTarget } from "./comment-routing.ts";
import type { WorkflowStep } from "./compose.ts";
import type { WorkflowPendingDelivery } from "./run-projection.ts";
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
  outOfBandReviewTargets?: Readonly<
    Record<number, readonly WorkflowCommentTarget[]>
  >;
};

export type WorkflowWakeInput =
  | { kind: "execute_escalation"; reason: string }
  | { kind: "github_reference"; eventId: number; references: readonly string[] }
  | { kind: "github_feedback" }
  | {
      kind: "diff_feedback";
      threadId: number;
      commentId: number;
      targets: readonly WorkflowCommentTarget[];
    }
  | {
      kind: "pr_comment";
      commentId: number;
      targets: readonly WorkflowCommentTarget[];
    }
  | {
      kind: "out_of_band_review";
      reviewId: number;
      targets: readonly WorkflowCommentTarget[];
    }
  | { kind: "cost_limit_increased" }
  | { kind: "rework_limit_increased" }
  | { kind: "human_instruction" }
  | { kind: "cost_exceeded"; eventId: number }
  | {
      kind: "queued_delivery";
      delivery: WorkflowPendingDelivery;
      target_available: boolean;
    }
  | { kind: "pending_delivery_ready"; delivery: WorkflowPendingDelivery }
  | { kind: "delivery_queue_drained" };

export type WorkflowEscalationContext = {
  current_step: WorkflowStep;
  active_step: WorkflowStep | null;
  current_head: string | null;
  needs_human_reason: string | null;
  awaiting_human: boolean;
};

export type WorkflowNextAction =
  | { action: "complete"; reason: string }
  | { action: "launch_execute"; reason: string; delivery_id?: string }
  | {
      action: "launch_verify";
      reason: string;
      delivery_id?: string;
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
      targets: readonly WorkflowCommentTarget[];
    }
  | {
      // A diff comment names its own subject, so the delivery text is fixed like rework's: the
      // parent hands over the ids and Execute reads the comment itself.
      action: "deliver";
      reason: string;
      delivery_reason: "diff_feedback";
      thread_id: number;
      comment_id: number;
      targets: readonly WorkflowCommentTarget[];
    }
  | {
      action: "deliver";
      reason: string;
      delivery_reason: "pr_comment";
      comment_id: number;
      targets: readonly WorkflowCommentTarget[];
    }
  | {
      action: "deliver";
      reason: string;
      delivery_reason: "human_instruction";
      transition: "resume_execute" | null;
    }
  | {
      // Release a hold and decide nothing else. The run's facts — reviews, turn done, HEAD — are
      // already in domain state, so the wake this resume emits reconciles them under the normal
      // rules instead of the hold path guessing what the held child got done (#369).
      action: "resume";
      reason: string;
      step: "execute" | "verify";
    }
  | {
      // The parent reads the named GitHub resources and submits its verdict. The
      // action carries the canonical references only; the untrusted body stays out of the result so
      // the trust boundary — reading and judging that content — remains the parent's alone.
      action: "read_github_reference";
      reason: string;
      event_id: number;
      references: readonly string[];
    }
  | { action: "cost_hold"; reason: string; event_id: number }
  | {
      action: "deliver_pending";
      reason: string;
      delivery_id: string;
      target: WorkflowCommentTarget;
      text: string;
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
      execution_context?: WorkflowEscalationContext;
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
  context: { repo: string; run: number; issue: number; pr: number },
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
      return watch([
        command(
          "launch-step",
          ...scoped,
          "--step",
          "execute",
          ...(action.delivery_id ? ["--delivery-id", action.delivery_id] : []),
        ),
      ]);
    case "launch_verify":
      return watch([
        command(
          "launch-step",
          ...scoped,
          "--step",
          "verify",
          ...(action.delivery_id ? ["--delivery-id", action.delivery_id] : []),
        ),
      ]);
    case "advance_and_verify":
      return watch([command("run", "advance-to-verify", ...scoped)]);
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
          `orchestrator: address review ${action.review_id}`,
        ),
      ]);
    case "deliver": {
      const deliveries = (
        text: string,
        targets: readonly WorkflowCommentTarget[],
      ) =>
        targets.map((target) =>
          command("deliver", ...scoped, "--target", target, "--text", text),
        );
      if (action.delivery_reason === "diff_feedback") {
        return watch([
          {
            command: "lh",
            args: [
              "pr",
              "feedback",
              "react",
              String(action.comment_id),
              "--pr",
              String(context.pr),
              "--emoji",
              "👀",
              "--repo",
              context.repo,
            ],
          },
          ...deliveries(
            `orchestrator: address diff feedback thread ${action.thread_id} comment ${action.comment_id}`,
            action.targets,
          ),
        ]);
      }
      if (action.delivery_reason === "pr_comment") {
        return watch([
          {
            command: "lh",
            args: [
              "pr",
              "comment",
              "react",
              String(action.comment_id),
              "--pr",
              String(context.pr),
              "--emoji",
              "👀",
              "--repo",
              context.repo,
            ],
          },
          ...deliveries(
            `orchestrator: address PR comment ${action.comment_id}`,
            action.targets,
          ),
        ]);
      }
      if (action.delivery_reason === "github_feedback") {
        return watch([
          command(
            "deliver",
            ...scoped,
            "--text",
            "GitHub PR のフィードバックを確認し、必要なローカル変更だけを実装してください。GitHub への返信は行わないでください。",
          ),
        ]);
      }
      const targets =
        action.delivery_reason === "out_of_band_review"
          ? action.targets
          : (["executor"] as const);
      const deliver = targets.map((target) => {
        const instruction = command("deliver", ...scoped, "--target", target);
        instruction.input = {
          argument: "--text",
          source: "delivery_instruction",
        };
        return instruction;
      });
      return watch(
        [
          ...("transition" in action && action.transition === "resume_execute"
            ? [command("run", "resume", ...scoped, "--step", "execute")]
            : []),
          ...deliver,
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
            "instruction",
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
    case "resume":
      return watch([
        command("run", "resume", ...scoped, "--step", action.step),
      ]);
    case "deliver_pending":
      return watch([
        command(
          "deliver",
          ...scoped,
          "--delivery-id",
          action.delivery_id,
          "--target",
          action.target,
          "--text",
          action.text,
        ),
      ]);
    case "wait":
      return watch([]);
    case "escalate": {
      const escalate = command("escalate-human", ...scoped);
      escalate.input = {
        argument: "--reason",
        source: "escalation_reason",
      };
      if (action.escalation_reason !== "execute_request") {
        return watch([escalate], "parent_judgement");
      }
      return {
        boundary: "parent_judgement",
        commands: [escalate],
        decision: {
          question:
            "Write a human-facing escalation comment from the request and execution context.",
          inputs: ["escalation reason", "execution context"],
          submit: null,
        },
        after: "watch",
      };
    }
    case "ask_human":
      return {
        boundary: "human_judgement",
        commands: [],
        decision: {
          question: action.reason,
          inputs: ["human answer"],
          submit: command(
            "instruction",
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

  // A cost hold outranks every non-terminal observation, including an established hold: the
  // detection re-emits while the parent is away (#1844), so a drained replay must still reach
  // `cost-hold`. Its (run, limit) receipt — not this decision — is what keeps the effect one-time.
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
      reason: `Effect "${input.pendingEffectReceipt.effect}" for event ${input.pendingEffectReceipt.event_id} has a pending receipt.`,
    };
  }

  // The only cost gate (#369). A held run is advised `wait` for every wake below except the two
  // human continuation decisions, so nothing here launches the next Execute / Verify or injects
  // into the child still running under the exceeded limit. That child is left alone and finishes
  // its step; the resulting single step of overspend is accepted rather than defended against.
  if (input.awaitingHuman) {
    // A run still held when its increase lands was raised by someone other than this parent — the
    // Issue Web UI (#1828). The increase is that human's continuation decision, so resume the step
    // the cost hold caught. A parent that increased the limit itself already resumed, so its
    // own wake falls through to the state rules below instead of resuming twice.
    if (input.wake?.kind === "cost_limit_increased") {
      if (input.costLimitIncreaseRequired) {
        return {
          action: "wait",
          reason:
            "The cost limit increased, but the new limit is already exceeded.",
        };
      }
      // Release the hold and stop there. A hold no longer interrupts the child (#369), so whatever
      // the held step got done — a verdict submitted, a turn declared, commits landed — is already
      // recorded, and the wake this resume emits lets the normal rules act on it. Deciding the next
      // step here instead would re-launch a Verify whose review already exists, or push Execute to
      // "continue" work it never stopped doing.
      if (input.activeStep === "execute" || input.activeStep === "verify") {
        return {
          action: "resume",
          reason:
            "A human increased the cost limit; release the hold and reconcile the run's own state.",
          step: input.activeStep,
        };
      }
      return {
        action: "wait",
        reason:
          "The cost limit increased, but the run has no held step to resume.",
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

  if (input.wake?.kind === "pending_delivery_ready") {
    return {
      action: "deliver_pending",
      reason: `A queued comment instruction can now reach ${input.wake.delivery.target}.`,
      delivery_id: input.wake.delivery.id,
      target: input.wake.delivery.target,
      text: input.wake.delivery.text,
    };
  }

  if (input.wake?.kind === "queued_delivery") {
    if (input.wake.target_available) {
      return {
        action: "deliver_pending",
        reason: `A queued comment instruction can now reach ${input.wake.delivery.target}.`,
        delivery_id: input.wake.delivery.id,
        target: input.wake.delivery.target,
        text: input.wake.delivery.text,
      };
    }
    if (input.wake.delivery.target === "verifier") {
      return {
        action: "launch_verify",
        reason: "A queued verifier instruction requires a fresh Verify child.",
        delivery_id: input.wake.delivery.id,
      };
    }
    if (input.wake.delivery.target === "executor") {
      return {
        action: "launch_execute",
        reason: "A queued executor instruction requires an Execute child.",
        delivery_id: input.wake.delivery.id,
      };
    }
    return {
      action: "wait",
      reason:
        "The queued orchestrator instruction has no registered parent session.",
    };
  }

  if (input.wake?.kind === "delivery_queue_drained") {
    return {
      action: "wait",
      reason: "Queued comment instruction delivery is complete.",
    };
  }

  if (input.wake?.kind === "rework_limit_increased") {
    const review = input.steps.verify.latest_review;
    if (
      input.currentStep === "verify" &&
      review?.fresh &&
      review.event === "request_changes" &&
      input.reworkCount < input.reworkLimit
    ) {
      return {
        action: "request_rework",
        reason: `A human increased the rework limit; review ${review.id} can be addressed.`,
        review_id: review.id,
      };
    }
    return {
      action: "wait",
      reason:
        "The rework limit increased, but the run has no fresh review to rework.",
    };
  }

  if (input.wake?.kind === "execute_escalation") {
    return {
      action: "escalate",
      reason: input.wake.reason,
      escalation_reason: "execute_request",
      execution_context: {
        current_step: input.currentStep,
        active_step: input.activeStep,
        current_head: input.currentHead,
        needs_human_reason: input.needsHumanReason,
        awaiting_human: input.awaitingHuman,
      },
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

  // One diff comment produces one run event, and the worker delivers each event's instructions
  // exactly once. Nothing here re-scans open threads: an undelivered comment is visible on the PR
  // and a human can post it again, which is cheaper than a redelivery rule that also has to decide
  // when a thread stops being new work.
  if (input.wake?.kind === "diff_feedback") {
    return {
      action: "deliver",
      reason: `Diff feedback conversation ${input.wake.threadId} has new workflow-agent input.`,
      delivery_reason: "diff_feedback",
      thread_id: input.wake.threadId,
      comment_id: input.wake.commentId,
      targets: input.wake.targets,
    };
  }

  if (input.wake?.kind === "pr_comment") {
    return {
      action: "deliver",
      reason: `PR comment ${input.wake.commentId} has new workflow-agent input.`,
      delivery_reason: "pr_comment",
      comment_id: input.wake.commentId,
      targets: input.wake.targets,
    };
  }

  if (input.wake?.kind === "out_of_band_review") {
    return {
      action: "deliver",
      reason: `Out-of-band review ${input.wake.reviewId} requires Execute work.`,
      delivery_reason: "out_of_band_review",
      review_id: input.wake.reviewId,
      targets: input.wake.targets,
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
      reason: `Out-of-band review ${outOfBandReview.id} (${outOfBandReview.verdict}) has not been addressed by its target workflow agents.`,
      delivery_reason: "out_of_band_review",
      review_id: outOfBandReview.id,
      targets: input.outOfBandReviewTargets?.[outOfBandReview.id] ?? [
        "executor",
      ],
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
        reason: `Fresh review ${review.id} requests changes, but the rework limit of ${input.reworkLimit} has been reached.`,
        escalation_reason: "rework_limit",
        review_id: review.id,
      };
    }
    return {
      action: "request_rework",
      reason: `Fresh review ${review.id} requests changes.`,
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
      reason: `Fresh review ${review.id} passes the current HEAD.`,
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
