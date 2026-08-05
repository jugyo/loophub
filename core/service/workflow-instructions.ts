import { createHash } from "node:crypto";
import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import * as S from "../store.ts";
import { herdrSessionName } from "../terminal/terminal-launch.ts";
import { parseWorkflowEventPayload } from "../workflow/event-payloads.ts";
import {
  classifyWorkflowSubjectEvent,
  type WorkflowSubjectEventRole,
  type WorkflowTwinSourceRef,
  workflowSubscriptionLowerBound,
} from "../workflow/source-events.ts";
import { sendHerdrPrompt } from "./herdr-prompt.ts";
import { repoOr404 } from "./shared.ts";
import { workflowRunParentPaneId } from "./workflow-panes.ts";
import { workflowRuns } from "./workflow-runs.ts";

const EFFECT_PREFIX = "workflow.instruction:";
const MISSING_PARENT_EFFECT = `${EFFECT_PREFIX}parent-pane-missing`;
const UNREADY_PARENT_EFFECT = `${EFFECT_PREFIX}parent-not-ready`;
const HERDR_TIMEOUT_MS = 15_000;
// Wide enough that machine load, not a broken launch, never closes the window: an unloaded parent
// signals readiness within ~30s of run creation, and a heavily loaded one has been measured past
// two minutes. Overshooting only delays how long a parent that never comes up stays invisible,
// while undershooting kills a healthy run permanently.
const PARENT_LAUNCH_GRACE_MS = 600_000;

export type WorkflowInstructionDispatchResult =
  | { status: "idle" }
  | { status: "skipped"; run: number; event: number; reason: string }
  | { status: "failed"; run: number; event?: number; error: string }
  | {
      status: "delivered";
      run: number;
      event: number;
      pane_id: string;
      action: string;
    };

// The next event the run has not consumed, selected from the three subjects it owns: itself, its
// issue and its PR. A run with no `workflow_run.started` event has no lower bound to subscribe
// from, and replaying its subjects' whole history is not a recovery — the missing start is raised
// so an operator decides, and the cursor stays put.
type WorkflowInstructionPendingResult = Exclude<
  WorkflowInstructionDispatchResult,
  { status: "idle" }
>;

export type WorkflowInstructionDispatchOutcome =
  WorkflowInstructionPendingResult & { durationMs: number };

function pendingEvent(run: S.WorkflowRunRow): S.EventRow | null {
  const startedEventId = S.workflowRunStartedEventId(run.repo_id, run.id);
  if (startedEventId === null) {
    throw new ServiceError(
      409,
      `Workflow run #${run.id} has no workflow_run.started event`,
    );
  }
  return S.nextWorkflowSubjectEvent({
    repoId: run.repo_id,
    runId: run.id,
    issueNumber: run.issue_number,
    prNumber: run.pr_number,
    afterId: workflowSubscriptionLowerBound(run.event_cursor, startedEventId),
  });
}

function pendingEventRole(
  repoId: number,
  event: S.EventRow,
): WorkflowSubjectEventRole {
  const markedSourceExists = (ref: WorkflowTwinSourceRef): boolean =>
    ref.kind === "event"
      ? S.hasMarkedWorkflowSourceEvent(repoId, ref.sourceEventId)
      : S.hasMarkedWorkflowReviewSourceEvent(repoId, ref.reviewId);
  return classifyWorkflowSubjectEvent(
    {
      type: event.type,
      payload: parseWorkflowEventPayload(event.payload) ?? {},
    },
    markedSourceExists,
  );
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

// A decision with no pane operation of its own: the receipt and the cursor it retires commit
// together, so a recorded decision never leaves its event to be dispatched again.
function completeDecision(
  runId: number,
  eventId: number,
  effect: string,
): void {
  db.transaction(() => {
    const claimed = S.beginWorkflowEventEffect(
      runId,
      eventId,
      effect,
      "subject",
    );
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
    S.advanceWorkflowRunEventCursor(runId, eventId);
  });
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
      launched_at: string;
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
    if (!Number.isFinite(Date.parse(input.launched_at))) {
      throw new ServiceError(422, "invalid Workflow parent launch timestamp");
    }
    // The pane row and the link that makes it findable as this run's parent are one registration.
    return db.transaction(() => {
      S.setAgentSessionCreatedAt(input.launch_id, input.launched_at);
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
    });
  },

  // Record readiness and synchronously release the instruction that was waiting on it. This keeps
  // the command's success tied to delivery instead of relying on a later worker poll. A worker that
  // still has the pre-readiness implementation may have claimed or completed the event already;
  // surface that existing receipt instead of reporting a successful handshake.
  async parentReady(
    name: string,
    input: { run: number },
  ): Promise<{
    run: number;
    ready_at: string;
    instruction: WorkflowInstructionDispatchResult;
  }> {
    const repo = repoOr404(name);
    const run = S.getWorkflowRun(input.run);
    if (!run || run.repo_id !== repo.id) {
      throw new ServiceError(404, `Workflow run #${input.run} not found`);
    }
    const readyRow = S.markWorkflowRunParentReadyIfNoEffect(
      run.id,
      EFFECT_PREFIX,
    );
    if (!readyRow?.parent_ready_at || readyRow.parent_ready_confirmed !== 1) {
      const pending = S.pendingWorkflowEventEffectWithPrefix(
        run.id,
        EFFECT_PREFIX,
      );
      if (pending) {
        throw new ServiceError(
          409,
          `Workflow instruction delivery for event #${pending.event_id} has a pending receipt`,
        );
      }
      const completed = S.latestCompletedWorkflowEventEffectWithPrefix(
        run.id,
        Number.MAX_SAFE_INTEGER,
        EFFECT_PREFIX,
      );
      if (completed) {
        throw new ServiceError(
          409,
          `Workflow instruction for event #${completed.event_id} was recorded before parent readiness; delivery cannot be confirmed`,
        );
      }
      throw new ServiceError(
        500,
        `could not record parent readiness for Workflow run #${run.id}`,
      );
    }
    const ready = { run: readyRow.id, ready_at: readyRow.parent_ready_at };

    let instruction = await this.dispatchRun(ready.run);
    while (instruction.status === "skipped") {
      instruction = await this.dispatchRun(ready.run);
    }
    if (instruction.status === "idle") {
      const current = S.getWorkflowRun(ready.run);
      const event = current ? pendingEvent(current) : null;
      if (event) {
        throw new ServiceError(
          409,
          `Workflow instruction for event #${event.id} is pending but was not delivered`,
        );
      }
    }
    return { ...ready, instruction };
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

    const repo = S.getRepoById(run.repo_id);
    if (!repo) {
      throw new ServiceError(
        404,
        `Repository for Workflow run #${run.id} not found`,
      );
    }

    // Wake-only sources predate the stable payload contract, so their legacy twin still owns the
    // instruction. Conversely, a twin whose source is marked arrived after that source already
    // owned it. Reconcile the state each row announced, but neither row represents an instruction
    // side effect: advance the cursor without creating a receipt that would falsely claim one.
    const role = pendingEventRole(run.repo_id, event);
    if (role !== "instruction") {
      await workflowRuns.next(repo.full_name, {
        run: run.id,
        event: event.id,
      });
      S.advanceWorkflowRunEventCursor(run.id, event.id);
      return {
        status: "skipped",
        run: run.id,
        event: event.id,
        reason:
          role === "wake_only"
            ? "Event only wakes state observation"
            : "Instruction was superseded by its source event",
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

    // A run is created before its parent pane is launched and registered, and the agent in that pane
    // only starts reading it later still. Both facts gate delivery: `send-text` writes bytes to the
    // pane's terminal, and an agent that has not finished starting never reads what was written
    // before it attached — the delivery would record itself as done and the run would wait forever.
    // Allow the bounded launch window for both without reconciling the event; afterward, claim a
    // durable failure receipt so a parent that never came up is visible exactly once.
    const registeredPane = workflowRunParentPaneId(run);
    const paneMissing = registeredPane === undefined;
    if (paneMissing || !run.parent_ready_at) {
      if (parentLaunchPending(run)) return { status: "idle" };
      const claimed = S.beginWorkflowEventEffect(
        run.id,
        event.id,
        paneMissing ? MISSING_PARENT_EFFECT : UNREADY_PARENT_EFFECT,
        "subject",
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
      return {
        status: "skipped",
        run: run.id,
        event: event.id,
        reason: "Instruction matches the previous state change",
      };
    }
    if (instruction.action === "wait" || instruction.action === "complete") {
      completeDecision(run.id, event.id, effect);
      return {
        status: "skipped",
        run: run.id,
        event: event.id,
        reason: instruction.reason,
      };
    }

    // Claim before the non-transactional pane operation. An ambiguous failure remains pending and
    // blocks later events; recovery is an explicit operator decision rather than an automatic retry.
    const claimed = S.beginWorkflowEventEffect(
      run.id,
      event.id,
      effect,
      "subject",
    );
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
    // The pane operation is done and cannot be undone, so this is a second short DB region: the
    // receipt completion and the cursor advance still commit together.
    db.transaction(() => {
      const completed = S.completeWorkflowEventEffect(run.id, event.id, effect);
      if (!completed) {
        throw new ServiceError(
          500,
          `could not complete Workflow instruction event #${event.id}`,
        );
      }
      S.advanceWorkflowRunEventCursor(run.id, event.id);
    });
    return {
      status: "delivered",
      run: run.id,
      event: event.id,
      pane_id: registeredPane,
      action: instruction.action,
    };
  },

  async dispatchPending(): Promise<WorkflowInstructionDispatchOutcome[]> {
    const results: WorkflowInstructionDispatchOutcome[] = [];
    for (const run of S.workflowRunsWithPendingEvents()) {
      if (S.pendingWorkflowEventEffectWithPrefix(run.id, EFFECT_PREFIX))
        continue;
      const startedAt = Date.now();
      const runResults: WorkflowInstructionPendingResult[] = [];
      // Consume non-actionable observations, but stop after one injected instruction so a parent
      // has a chance to execute it before another state-derived action is delivered.
      try {
        for (;;) {
          const result = await this.dispatchRun(run.id);
          if (result.status === "idle") break;
          runResults.push(result);
          if (result.status === "delivered") break;
        }
      } catch (error) {
        const current = S.getWorkflowRun(run.id);
        runResults.push({
          status: "failed",
          run: run.id,
          event: current ? pendingEvent(current)?.id : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const durationMs = Date.now() - startedAt;
      results.push(...runResults.map((result) => ({ ...result, durationMs })));
    }
    return results;
  },
};
