import { ServiceError } from "../errors.ts";
import * as S from "../store.ts";
import { agentControl } from "./agent-control.ts";
import { ensureWritable, repoOr404 } from "./shared.ts";
import { workflowRunCost, workflowRuns } from "./workflow-runs.ts";

const EFFECT = "cost.hold";

export type WorkflowCostHoldResult = {
  run: number;
  limit_usd: number;
  receipt: "pending" | "completed" | null;
  status:
    | "completed"
    | "already_completed"
    | "not_exceeded"
    | "pending"
    | "failed";
  completed: string[];
  failed?: {
    step: string;
    command: string;
    error: string;
  };
};

type CostHoldSubject = { run: number; limit_usd: number };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedResult(
  subject: CostHoldSubject,
  completed: string[],
  step: string,
  command: string,
  error: unknown,
): WorkflowCostHoldResult {
  return {
    ...subject,
    receipt: "pending",
    status: "failed",
    completed,
    failed: { step, command, error: message(error) },
  };
}

// The child to interrupt is the one the run row records as active — the same target `deliver` and
// `launch` last wrote, and the only one whose pane belongs to this run.
function activeTarget(run: S.WorkflowRunRow): S.AgentExecutionTargetRow {
  if (!run.active_step || !run.active_session_id) {
    throw new ServiceError(409, `Workflow run #${run.id} has no active child`);
  }
  const target = S.getAgentExecutionTarget(run.active_session_id);
  if (!target) {
    throw new ServiceError(
      409,
      `active session ${run.active_session_id} has no execution target`,
    );
  }
  return target;
}

export const workflowCostHold = {
  async run(
    name: string,
    input: { run: number },
    sessionId?: string | null,
  ): Promise<WorkflowCostHoldResult> {
    const repo = repoOr404(name);
    ensureWritable(repo);
    const run = S.getWorkflowRun(input.run);
    if (!run || run.repo_id !== repo.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    if (
      (!sessionId || sessionId !== run.parent_session_id) &&
      (!sessionId || S.getAgentSession(sessionId)?.agent !== "me")
    ) {
      throw new ServiceError(
        403,
        "Workflow cost hold must be issued by the parent session",
      );
    }
    // Every value this command needs is on the run row or in usage: the cumulative limit, the cost
    // reached against it, and the active child. A parent woken by a ping carries no event id, so
    // the interrupt has to be resolvable from state alone.
    const { limitUsd, summary } = workflowRunCost(run);
    const subject: CostHoldSubject = { run: run.id, limit_usd: limitUsd };
    // Scoped to the run's cumulative limit rather than one event id (#1844): detection re-emits
    // `workflow_run.cost_exceeded` while a stopped parent is away, so several events all ask for
    // the one interrupt this limit warrants. A per-event receipt would let each of them re-send Esc
    // and the child notification — and re-hold a run the human already released. A raised limit is
    // a different limit, which correctly holds again.
    const existingReceipt = S.getWorkflowEventEffectForCostLimit(
      run.id,
      EFFECT,
      limitUsd,
    );
    if (existingReceipt) {
      return {
        ...subject,
        receipt: existingReceipt.status,
        status:
          existingReceipt.status === "completed"
            ? "already_completed"
            : "pending",
        completed: [],
      };
    }
    if (run.status !== "running") {
      throw new ServiceError(409, `Workflow run is ${run.status}`);
    }
    // The recorded over-limit observation, which is also what the receipt anchors to. Its absence
    // — the state a granted increase leaves behind, with only the old limit's events on file — is
    // what says there is nothing at this limit to interrupt. Deliberately the same condition
    // `costLimitIncreaseAvailable` reads rather than a second, private cost comparison: detection
    // owns when a limit counts as exceeded, and two criteria would disagree around every sweep.
    const event = S.firstWorkflowRunCostExceededEvent(
      repo.id,
      run.id,
      limitUsd,
    );
    if (!event) {
      return {
        ...subject,
        receipt: null,
        status: "not_exceeded",
        completed: [],
      };
    }
    const receipt = S.beginWorkflowEventEffect(run.id, event.id, EFFECT);
    if (!receipt) {
      throw new ServiceError(409, `could not claim event #${event.id}`);
    }
    if (!receipt.acquired) {
      return {
        ...subject,
        receipt: receipt.row.status,
        status:
          receipt.row.status === "completed" ? "already_completed" : "pending",
        completed: [],
      };
    }

    const completed: string[] = [];
    let target: S.AgentExecutionTargetRow | undefined;
    let targetError: unknown;
    try {
      target = activeTarget(run);
    } catch (error) {
      targetError = error;
    }

    const costUsd =
      summary.cost_usd === null ? "unknown" : `$${summary.cost_usd}`;
    const reason = `Cost limit exceeded: current ${costUsd}, limit $${limitUsd}; human decision required`;
    try {
      await workflowRuns.awaitHuman(name, { run: run.id, reason }, sessionId);
    } catch (error) {
      return failedResult(
        subject,
        completed,
        "await-human",
        "hold the run for a human decision",
        error,
      );
    }
    completed.push("await-human");

    if (targetError || !target) {
      return failedResult(
        subject,
        completed,
        "target resolution",
        "resolve active child execution target",
        targetError ?? new Error("active execution target was not resolved"),
      );
    }

    const executionTarget = {
      provider: target.provider,
      targetId: target.target_id,
      context: target.context,
    };
    const control = agentControl(repo.local_path, executionTarget);
    try {
      await control.inputKey(executionTarget, "Escape");
    } catch (error) {
      return failedResult(
        subject,
        completed,
        "Escape",
        "send Escape to active child",
        error,
      );
    }
    completed.push("Escape");

    const notification = `orchestrator: Cost limit exceeded: current ${costUsd}, limit $${limitUsd}. Wait for human instruction.`;
    try {
      await control.inputText(executionTarget, notification);
    } catch (error) {
      return failedResult(
        subject,
        completed,
        "child notification",
        "send notification to active child",
        error,
      );
    }
    completed.push("child notification");

    const completedReceipt = S.completeWorkflowEventEffect(
      run.id,
      event.id,
      EFFECT,
    );
    if (!completedReceipt) {
      return failedResult(
        subject,
        completed,
        "receipt completion",
        `complete ${EFFECT} receipt for Workflow run #${run.id}`,
        new Error("effect receipt not found"),
      );
    }
    return {
      ...subject,
      receipt: completedReceipt.status,
      status: "completed",
      completed,
    };
  },
};
