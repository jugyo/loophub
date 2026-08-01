import { createHash } from "node:crypto";
import { ServiceError } from "../errors.ts";
import * as S from "../store.ts";
import { HERDR_ID, herdrSessionName } from "../terminal/terminal-launch.ts";
import { sendHerdrPrompt } from "./herdr-prompt.ts";
import { repoOr404 } from "./shared.ts";
import { workflowRuns } from "./workflow-runs.ts";

const EFFECT_PREFIX = "workflow.instruction:";
const MISSING_PARENT_EFFECT = `${EFFECT_PREFIX}parent-pane-missing`;
const UNREADY_PARENT_EFFECT = `${EFFECT_PREFIX}parent-not-ready`;
const HERDR_TIMEOUT_MS = 15_000;
const PARENT_LAUNCH_GRACE_MS = 120_000;

export type WorkflowInstructionDispatchResult =
  | { status: "idle" }
  | { status: "skipped"; run: number; event: number; reason: string }
  | { status: "failed"; run: number; error: string }
  | {
      status: "delivered";
      run: number;
      event: number;
      pane_id: string;
      action: string;
    };

function pendingEvent(run: S.WorkflowRunRow): S.EventRow | null {
  return (
    S.eventsForWorkflowRun(run.repo_id, run.id).find(
      (event) => event.id > run.event_cursor,
    ) ?? null
  );
}

function parentPane(run: S.WorkflowRunRow): string | null | undefined {
  const matches = S.listHerdrPanesForResource({
    repoId: run.repo_id,
    resourceKind: "workflow_run",
    resourceKey: String(run.id),
  });
  if (matches.length === 0) return undefined;
  if (matches.length !== 1 || !matches[0].pane_id) return null;
  return HERDR_ID.test(matches[0].pane_id) ? matches[0].pane_id : null;
}

function parentLaunchPending(run: S.WorkflowRunRow): boolean {
  return Date.now() - Date.parse(run.created_at) < PARENT_LAUNCH_GRACE_MS;
}

function instructionText(
  result: Awaited<ReturnType<typeof workflowRuns.next>>,
): string {
  return `workflow instruction: ${JSON.stringify(result)}`;
}

function instructionEffect(
  result: Awaited<ReturnType<typeof workflowRuns.next>>,
): string {
  const decision = {
    action: result.action,
    reason: result.reason,
    instructions: result.instructions,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(decision))
    .digest("hex");
  return `${EFFECT_PREFIX}${digest}`;
}

function completeDecision(
  runId: number,
  eventId: number,
  effect: string,
): void {
  const claimed = S.beginWorkflowEventEffect(runId, eventId, effect);
  if (!claimed?.acquired) {
    throw new ServiceError(
      409,
      `could not record Workflow instruction decision for event #${eventId}`,
    );
  }
  if (!S.completeWorkflowEventEffect(runId, eventId, effect)) {
    throw new ServiceError(
      500,
      `could not complete Workflow instruction decision for event #${eventId}`,
    );
  }
}

function sendInstruction(
  repo: S.Repo,
  paneId: string,
  text: string,
): Promise<void> {
  return sendHerdrPrompt({
    sessionName: herdrSessionName(repo),
    paneId,
    text,
    cwd: repo.local_path,
    timeoutMs: HERDR_TIMEOUT_MS,
  });
}

export const workflowInstructions = {
  registerParentPane(
    name: string,
    input: {
      run: number;
      launch_id: string;
      session_name: string;
      pane_id: string | null;
    },
  ): S.HerdrPaneRow {
    const repo = repoOr404(name);
    const run = S.getWorkflowRun(input.run);
    if (!run || run.repo_id !== repo.id) {
      throw new ServiceError(404, `Workflow run #${input.run} not found`);
    }
    if (!run.parent_session_id || run.parent_session_id !== input.launch_id) {
      throw new ServiceError(
        409,
        `Workflow run #${run.id} parent session does not match`,
      );
    }
    const pane = S.registerHerdrPane({
      repoId: repo.id,
      launchId: input.launch_id,
      paneId: input.pane_id,
      sessionName: input.session_name,
      displayName: `Workflow parent #${run.id}`,
      origin: "workflow",
    });
    S.linkHerdrPaneResource({
      repoId: repo.id,
      launchId: pane.launch_id,
      resourceKind: "workflow_run",
      resourceKey: String(run.id),
    });
    return pane;
  },

  // The parent agent's own declaration that it is running and reads its pane, which is the fact
  // delivery waits for. Nothing here authenticates the caller: the signal exists for timing, and the
  // same CLI already lets a human hand the parent an instruction directly.
  markParentReady(
    name: string,
    input: { run: number },
  ): { run: number; ready_at: string } {
    const repo = repoOr404(name);
    const run = S.getWorkflowRun(input.run);
    if (!run || run.repo_id !== repo.id) {
      throw new ServiceError(404, `Workflow run #${input.run} not found`);
    }
    const ready = S.markWorkflowRunParentReady(run.id);
    if (!ready?.parent_ready_at) {
      throw new ServiceError(
        500,
        `could not record parent readiness for Workflow run #${run.id}`,
      );
    }
    return { run: ready.id, ready_at: ready.parent_ready_at };
  },

  async dispatchRun(runId: number): Promise<WorkflowInstructionDispatchResult> {
    const run = S.getWorkflowRun(runId);
    if (!run) return { status: "idle" };
    const event = pendingEvent(run);
    if (!event) return { status: "idle" };

    if (run.status !== "running") {
      S.advanceWorkflowRunEventCursor(run.id, event.id);
      return {
        status: "skipped",
        run: run.id,
        event: event.id,
        reason: `Workflow run is ${run.status}`,
      };
    }

    const receipt = S.getWorkflowEventEffectWithPrefix(
      run.id,
      event.id,
      EFFECT_PREFIX,
    );
    if (receipt?.status === "pending") {
      throw new ServiceError(
        409,
        `Workflow instruction delivery for event #${event.id} has a pending receipt`,
      );
    }
    if (receipt?.status === "completed") {
      S.advanceWorkflowRunEventCursor(run.id, event.id);
      return {
        status: "skipped",
        run: run.id,
        event: event.id,
        reason: "Instruction was already delivered",
      };
    }

    const repo = S.getRepoById(run.repo_id);
    if (!repo) {
      throw new ServiceError(
        404,
        `Repository for Workflow run #${run.id} not found`,
      );
    }
    // A run is created before its parent pane is launched and registered, and the agent in that pane
    // only starts reading it later still. Both facts gate delivery: `send-text` writes bytes to the
    // pane's terminal, and an agent that has not finished starting never reads what was written
    // before it attached — the delivery would record itself as done and the run would wait forever.
    // Allow the bounded launch window for both without reconciling the event; afterward, claim a
    // durable failure receipt so a parent that never came up is visible exactly once.
    const registeredPane = parentPane(run);
    const paneMissing = registeredPane === undefined;
    if (paneMissing || !run.parent_ready_at) {
      if (parentLaunchPending(run)) return { status: "idle" };
      const claimed = S.beginWorkflowEventEffect(
        run.id,
        event.id,
        paneMissing ? MISSING_PARENT_EFFECT : UNREADY_PARENT_EFFECT,
      );
      if (!claimed?.acquired) {
        throw new ServiceError(
          409,
          `could not record unusable parent pane for Workflow run #${run.id}`,
        );
      }
      throw new ServiceError(
        409,
        paneMissing
          ? `parent pane registration timed out for Workflow run #${run.id}`
          : `parent agent readiness timed out for Workflow run #${run.id}`,
      );
    }

    const instruction = await workflowRuns.next(repo.full_name, {
      run: run.id,
      event: event.id,
    });
    const effect = instructionEffect(instruction);
    const previous = S.latestCompletedWorkflowEventEffectWithPrefix(
      run.id,
      event.id,
      EFFECT_PREFIX,
    );
    if (previous?.effect === effect) {
      completeDecision(run.id, event.id, effect);
      S.advanceWorkflowRunEventCursor(run.id, event.id);
      return {
        status: "skipped",
        run: run.id,
        event: event.id,
        reason: "Instruction matches the previous state change",
      };
    }
    if (instruction.action === "wait" || instruction.action === "complete") {
      completeDecision(run.id, event.id, effect);
      S.advanceWorkflowRunEventCursor(run.id, event.id);
      return {
        status: "skipped",
        run: run.id,
        event: event.id,
        reason: instruction.reason,
      };
    }

    // Claim before the non-transactional pane operation. An ambiguous failure remains pending and
    // blocks later events; recovery is an explicit operator decision rather than an automatic retry.
    const claimed = S.beginWorkflowEventEffect(run.id, event.id, effect);
    if (!claimed) {
      throw new ServiceError(
        409,
        `could not claim Workflow instruction event #${event.id}`,
      );
    }
    if (!claimed.acquired) {
      throw new ServiceError(
        409,
        `Workflow instruction delivery for event #${event.id} has a ${claimed.row.status} receipt`,
      );
    }
    if (registeredPane === null) {
      throw new ServiceError(
        409,
        `could not resolve one parent pane for Workflow run #${run.id}`,
      );
    }

    await sendInstruction(repo, registeredPane, instructionText(instruction));
    const completed = S.completeWorkflowEventEffect(run.id, event.id, effect);
    if (!completed) {
      throw new ServiceError(
        500,
        `could not complete Workflow instruction event #${event.id}`,
      );
    }
    S.advanceWorkflowRunEventCursor(run.id, event.id);
    return {
      status: "delivered",
      run: run.id,
      event: event.id,
      pane_id: registeredPane,
      action: instruction.action,
    };
  },

  async dispatchPending(): Promise<WorkflowInstructionDispatchResult[]> {
    const results: WorkflowInstructionDispatchResult[] = [];
    for (const run of S.workflowRunsWithPendingEvents()) {
      if (S.pendingWorkflowEventEffectWithPrefix(run.id, EFFECT_PREFIX))
        continue;
      // Consume non-actionable observations, but stop after one injected instruction so a parent
      // has a chance to execute it before another state-derived action is delivered.
      try {
        for (;;) {
          const result = await this.dispatchRun(run.id);
          if (result.status === "idle") break;
          results.push(result);
          if (result.status === "delivered") break;
        }
      } catch (error) {
        results.push({
          status: "failed",
          run: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  },
};
