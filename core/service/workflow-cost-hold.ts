import { ServiceError } from "../errors.ts";
import * as S from "../store.ts";
import { parseWorkflowEventPayload } from "../workflow/event-payloads.ts";
import { workflowStepSessionIds } from "../workflow/herdr-agents.ts";
import { agentControl } from "./agent-control.ts";
import { ensureWritable, repoOr404 } from "./shared.ts";
import { workflowRuns } from "./workflow-runs.ts";

const EFFECT = "cost.hold";

type CostExceededPayload = {
  id: number;
  active_step: "execute" | "verify" | null;
  active_session_id: string | null;
  cost_usd: number;
  limit_usd: number;
};

export type WorkflowCostHoldResult = {
  run: number;
  event: number;
  receipt: "pending" | "completed";
  status: "completed" | "already_completed" | "pending" | "failed";
  completed: string[];
  failed?: {
    step: string;
    command: string;
    error: string;
  };
};

function costExceededPayload(
  event: S.EventRow,
  runId: number,
): CostExceededPayload {
  if (event.type !== "workflow_run.cost_exceeded") {
    throw new ServiceError(
      422,
      `event #${event.id} is not a workflow_run.cost_exceeded event`,
    );
  }
  const value = parseWorkflowEventPayload(event.payload);
  if (!value) {
    throw new ServiceError(422, `event #${event.id} has an invalid payload`);
  }
  const incomplete = new ServiceError(
    422,
    `event #${event.id} is missing its active child or cost data`,
  );
  if (value.id !== runId) throw incomplete;
  const activeStep = value.active_step;
  if (
    activeStep !== null &&
    activeStep !== "execute" &&
    activeStep !== "verify"
  ) {
    throw incomplete;
  }
  const activeSessionId = value.active_session_id;
  if (
    activeSessionId !== null &&
    (typeof activeSessionId !== "string" || activeSessionId === "")
  ) {
    throw incomplete;
  }
  const costUsd = value.cost_usd;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd))
    throw incomplete;
  const limitUsd = value.limit_usd;
  if (typeof limitUsd !== "number" || !Number.isFinite(limitUsd)) {
    throw incomplete;
  }
  return {
    id: runId,
    active_step: activeStep,
    active_session_id: activeSessionId,
    cost_usd: costUsd,
    limit_usd: limitUsd,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedResult(
  input: { run: number; event: number },
  completed: string[],
  step: string,
  command: string,
  error: unknown,
): WorkflowCostHoldResult {
  return {
    ...input,
    receipt: "pending",
    status: "failed",
    completed,
    failed: { step, command, error: message(error) },
  };
}

function activeTarget(input: {
  run: S.WorkflowRunRow;
  payload: CostExceededPayload;
}): S.AgentExecutionTargetRow {
  if (!input.payload.active_step || !input.payload.active_session_id) {
    throw new ServiceError(409, "cost exceeded event has no active child");
  }
  if (
    !workflowStepSessionIds(
      input.run.step_sessions_json,
      input.payload.active_step,
    ).includes(input.payload.active_session_id)
  ) {
    throw new ServiceError(
      409,
      `active session ${input.payload.active_session_id} is not registered for ${input.payload.active_step}`,
    );
  }
  const target = S.getAgentExecutionTarget(input.payload.active_session_id);
  if (!target) {
    throw new ServiceError(
      409,
      `active session ${input.payload.active_session_id} has no execution target`,
    );
  }
  return target;
}

export const workflowCostHold = {
  async run(
    name: string,
    input: { run: number; event: number },
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
    const event = S.eventsForWorkflowRun(repo.id, run.id).find(
      (candidate) => candidate.id === input.event,
    );
    if (!event) {
      throw new ServiceError(
        404,
        `event #${input.event} not found for Workflow run #${input.run}`,
      );
    }
    const payload = costExceededPayload(event, run.id);
    // Scoped to the run's cumulative limit rather than this event id (#1844): detection re-emits
    // `workflow_run.cost_exceeded` while a stopped parent is away, so the parent drains several
    // events that all ask for the one interrupt this limit warrants. A per-event receipt would let
    // each of them re-send Esc and the child notification — and re-hold a run the human already
    // released. A raised limit produces events at a new `limit_usd`, which correctly holds again.
    const existingReceipt = S.getWorkflowEventEffectForCostLimit(
      run.id,
      EFFECT,
      payload.limit_usd,
    );
    if (existingReceipt) {
      return {
        ...input,
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
    const receipt = S.beginWorkflowEventEffect(run.id, event.id, EFFECT);
    if (!receipt) {
      throw new ServiceError(409, `could not claim event #${event.id}`);
    }
    if (!receipt.acquired) {
      return {
        ...input,
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
      target = activeTarget({ run, payload });
    } catch (error) {
      targetError = error;
    }

    const reason = `Cost limit exceeded: current $${payload.cost_usd}, limit $${payload.limit_usd}; human decision required`;
    try {
      await workflowRuns.awaitHuman(name, { run: run.id, reason }, sessionId);
    } catch (error) {
      return failedResult(
        input,
        completed,
        "await-human",
        `lh workflow run await-human --repo ${name} --run ${run.id}`,
        error,
      );
    }
    completed.push("await-human");

    if (targetError || !target) {
      return failedResult(
        input,
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
        input,
        completed,
        "Escape",
        "send Escape to active child",
        error,
      );
    }
    completed.push("Escape");

    const notification = `orchestrator: Cost limit exceeded: current $${payload.cost_usd}, limit $${payload.limit_usd}. Wait for human instruction.`;
    try {
      await control.inputText(executionTarget, notification);
    } catch (error) {
      return failedResult(
        input,
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
        input,
        completed,
        "receipt completion",
        `complete ${EFFECT} receipt for event #${event.id}`,
        new Error("effect receipt not found"),
      );
    }
    return {
      ...input,
      receipt: completedReceipt.status,
      status: "completed",
      completed,
    };
  },
};
