import { ServiceError } from "../errors.ts";
import * as S from "../store.ts";
import {
  NO_PANE_ID_PREFIX,
  parseHerdrAgentList,
} from "../terminal/herdr-status.ts";
import { HERDR_ID, herdrSessionName } from "../terminal/terminal-launch.ts";
import { parseWorkflowEventPayload } from "../workflow/event-payloads.ts";
import {
  parseWorkflowHerdrAgentName,
  workflowStepSessionIds,
} from "../workflow/herdr-agents.ts";
import { runHerdr } from "./herdr-runner.ts";
import { ensureWritable, repoOr404 } from "./shared.ts";
import { workflowRuns } from "./workflow-runs.ts";

const EFFECT = "cost.hold";
const HERDR_TIMEOUT_MS = 15_000;

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

async function activePane(input: {
  repo: S.Repo;
  run: S.WorkflowRunRow;
  payload: CostExceededPayload;
}): Promise<{ paneId: string; sessionName: string }> {
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
  const session = S.getAgentSession(input.payload.active_session_id);
  const parsedName = parseWorkflowHerdrAgentName(session?.name);
  if (
    parsedName?.kind !== "step" ||
    parsedName.runId !== input.run.id ||
    parsedName.step !== input.payload.active_step
  ) {
    throw new ServiceError(
      409,
      `active session ${input.payload.active_session_id} has no matching Workflow agent`,
    );
  }
  const sessionName = herdrSessionName(input.repo);
  const stdout = await runHerdr(
    "herdr",
    ["--session", sessionName, "agent", "list"],
    input.repo.local_path,
    { captureStdout: true, timeoutMs: HERDR_TIMEOUT_MS },
  );
  const matches = parseHerdrAgentList(stdout).filter(
    (agent) =>
      agent.name === session?.name &&
      !agent.id.startsWith(NO_PANE_ID_PREFIX) &&
      HERDR_ID.test(agent.id),
  );
  if (matches.length !== 1) {
    throw new ServiceError(
      409,
      `could not resolve one pane for active agent ${session?.name}`,
    );
  }
  return { paneId: matches[0].id, sessionName };
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
    // each of them re-send Esc and the pane notification — and re-hold a run the human already
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
    const listCommand = `herdr --session ${herdrSessionName(repo)} agent list`;
    let pane: Awaited<ReturnType<typeof activePane>> | undefined;
    let paneError: unknown;
    try {
      pane = await activePane({ repo, run, payload });
    } catch (error) {
      paneError = error;
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

    if (paneError || !pane) {
      return failedResult(
        input,
        completed,
        "pane resolution",
        listCommand,
        paneError ?? new Error("active pane was not resolved"),
      );
    }

    const escapeCommand = `herdr --session ${pane.sessionName} pane send-keys ${pane.paneId} Escape`;
    try {
      await runHerdr(
        "herdr",
        [
          "--session",
          pane.sessionName,
          "pane",
          "send-keys",
          pane.paneId,
          "Escape",
        ],
        repo.local_path,
        { timeoutMs: HERDR_TIMEOUT_MS },
      );
    } catch (error) {
      return failedResult(input, completed, "Escape", escapeCommand, error);
    }
    completed.push("Escape");

    const notification = `orchestrator: Cost limit exceeded: current $${payload.cost_usd}, limit $${payload.limit_usd}. Wait for human instruction.`;
    const notificationCommand = `herdr --session ${pane.sessionName} pane run ${pane.paneId} ${notification}`;
    try {
      await runHerdr(
        "herdr",
        [
          "--session",
          pane.sessionName,
          "pane",
          "run",
          pane.paneId,
          notification,
        ],
        repo.local_path,
        { timeoutMs: HERDR_TIMEOUT_MS },
      );
    } catch (error) {
      return failedResult(
        input,
        completed,
        "pane notification",
        notificationCommand,
        error,
      );
    }
    completed.push("pane notification");

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
