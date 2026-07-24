import { createHash, randomUUID } from "node:crypto";
import {
  agentModel,
  type CodingAgent,
  configDir,
  costReemitMs,
  devCostLimitUsd,
  normalizeCodingAgent,
  worktreeRoot,
} from "../config.ts";
import {
  acquireDevLock,
  devLockPath,
  pidAlive,
  removeDevLock,
} from "../dev-lock.ts";
import { resolveWorktreeIdentity } from "../resume.ts";
import {
  effectiveRepoAgentConfigFor,
  type WorkflowOutOfBandReviewWire,
  type WorkflowPendingEffectReceiptWire,
  type WorkflowRunHistoryEventWire,
  type WorkflowRunReviewSummaryWire,
  type WorkflowRunStateWire,
  type WorkflowStepStatusWire,
} from "../serialize.ts";
import {
  NO_PANE_ID_PREFIX,
  parseHerdrAgentList,
} from "../terminal/herdr-status.ts";
import {
  buildWorkflowStepHerdrLaunchPlan,
  HERDR_ID,
  herdrSessionName,
} from "../terminal/terminal-launch.ts";
import { parsePreviousWorkflowVerifyPane } from "../terminal/workflow-pane-layout.ts";
import {
  composeWorkflowLaunchPrompt,
  renderWorkflowContract,
  WORKFLOW_STEPS,
  type WorkflowInputPointer,
  type WorkflowStep,
} from "../workflow/compose.ts";
import {
  type WorkflowContractLanguage,
  workflowContractText,
} from "../workflow/contracts.ts";
import {
  nextWorkflowChildSequence,
  parseWorkflowHerdrAgentName,
  type WorkflowHerdrAgent,
  workflowStepSessionIds,
} from "../workflow/herdr-agents.ts";
import { workflowMessages } from "../workflow/messages.ts";
import {
  inlineText,
  parentUserPrompt,
  stepContractForLaunch,
  workflowStepPrompt,
} from "../workflow/prompts.ts";
import {
  reconcileWorkflow,
  WORKFLOW_REWORK_LIMIT,
  type WorkflowNextAction,
  type WorkflowWakeInput,
} from "../workflow/reconcile.ts";
import {
  writeParentContract,
  writeStepContract,
} from "../workflow/run-files.ts";
import type { WorkflowLatestReviewState } from "../workflow/steps.ts";
import {
  isHeadAheadOfReview,
  workflowRunProgress as observeWorkflowRunProgress,
  pinnedBaseSha,
  type WorkflowRunProgress,
  worktreeHead,
} from "../workflow-run-progress.ts";
import {
  legacyWorktreePath,
  worktreePath as prWorktreePath,
} from "../worktree-path.ts";
import {
  provisionWorktree,
  shouldCreateMissingConventionBranch,
} from "../worktree-provision.ts";
import { dev } from "./dev.ts";
import { runHerdr } from "./herdr-runner.ts";
import { workflowContractLanguage } from "./settings.ts";
import {
  actorFor,
  assertExistingLocalBranch,
  ensureWritable,
  formatEvent,
  issueOr404,
  type LoopEvent,
  repoOr404,
  S,
  ServiceError,
  UNKNOWN_ACTOR,
  workflowRunHistoryEventJSON,
  workflowRunStateJSON,
} from "./shared.ts";
import { workflowWatch } from "./workflow-watch.ts";

export type WorkflowRunStartResult = {
  run: {
    id: number;
    workflow_id: number | null;
    status: string;
    current_step: string;
    rework_count: number;
    parent_session_id: string | null;
  };
  workflow: { id: number; name: string };
  issue: { number: number; title: string };
  pr: { number: number; created: boolean };
  session_id: string;
  worktree: string;
  base_ref: string;
  head_ref: string;
  lock_path: string;
  parent: {
    system_prompt_path: string;
    user_prompt: string;
  };
};

export type WorkflowRunUpdateResult = {
  run: {
    id: number;
    workflow_id: number | null;
    status: string;
    current_step: string;
    rework_count: number;
    needs_human_reason: string | null;
    parent_session_id: string | null;
    step_sessions_json: string;
    active_step: string | null;
    active_session_id: string | null;
  };
};

export type WorkflowRunCostDetectionResult = {
  emitted: boolean;
  cost_usd: number | null;
  limit_usd: number;
};

export type WorkflowRunCostLimitIncreaseResult = {
  run: number;
  increment_usd: number;
  previous_limit_usd: number;
  current_limit_usd: number;
};

export type WorkflowLaunchStepResult = {
  run: WorkflowRunUpdateResult["run"];
  step: WorkflowStep;
  agent_name: string;
  // Runtime the step inherited from the parent run (#516). The CLI preflights this binary before
  // spawning the herdr launch it returns.
  runtime: CodingAgent;
  session_id: string;
  worktree: string;
  system_prompt_path: string;
  user_prompt: string;
  pointers: WorkflowInputPointer[];
  head_sha?: string;
  base_sha?: string;
  herdr: {
    sessionName: string;
    command: string;
    cwd: string;
    argv: string[];
  };
};

function workflowRunCost(run: S.WorkflowRunRow) {
  const sessionIds = [
    ...(run.parent_session_id ? [run.parent_session_id] : []),
    ...workflowStepSessionIds(run.step_sessions_json, "execute"),
    ...workflowStepSessionIds(run.step_sessions_json, "verify"),
  ];
  return {
    incrementUsd: run.cost_increment_usd ?? devCostLimitUsd(),
    limitUsd: run.cost_limit_usd ?? run.cost_increment_usd ?? devCostLimitUsd(),
    summary: S.sessionUsageCostSummaryForSessions(sessionIds),
  };
}

export type WorkflowConfirmStepLaunchResult = {
  run: WorkflowRunUpdateResult["run"];
  session_id: string;
};

export type WorkflowTurnDoneResult = {
  run: number;
  event_id: number;
};

export type WorkflowEscalateResult = WorkflowTurnDoneResult;

export type WorkflowDeliverResult = {
  run: number;
  agent_name: string;
  pane_id: string;
  session_id: string;
  text: string;
};

export type WorkflowStepInputResult = {
  run: WorkflowRunUpdateResult["run"];
  step: WorkflowStep;
  system_prompt: string;
  system_prompt_path: string;
  user_prompt: string;
  pointers: WorkflowInputPointer[];
};

export type WorkflowStepStatusResult = WorkflowStepStatusWire;

// The action plus the facts it was decided from. The snapshot travels with the action so the parent
// never has to re-observe state to act on it, and `event` names the run event this call woke on
// (`--watch`) or was pointed at (`--event`) — the parent needs its id for event-scoped commands
// such as `lh workflow cost-hold` and for reading a GitHub reference.
export type WorkflowNextResult = WorkflowNextAction & {
  observed: WorkflowStepStatusWire;
  event: LoopEvent | null;
};

function workflowByInput(input: { workflow?: string; workflowId?: number }) {
  if (input.workflow && input.workflowId !== undefined) {
    throw new ServiceError(
      422,
      "pass either --workflow or --workflow-id, not both",
    );
  }
  if (input.workflowId !== undefined) {
    const workflow = S.getWorkflowById(input.workflowId);
    if (!workflow) throw new ServiceError(404, "Workflow not found");
    return workflow;
  }
  if (input.workflow) {
    const workflow = S.getWorkflowByName(input.workflow.trim());
    if (!workflow) throw new ServiceError(404, "Workflow not found");
    return workflow;
  }
  throw new ServiceError(422, "--workflow or --workflow-id is required");
}

function workflowHumanReason(reason: string, action: string): string {
  const normalized = inlineText(reason);
  if (!normalized) {
    throw new ServiceError(422, `${action} requires a reason`);
  }
  if (normalized.length > 500) {
    throw new ServiceError(
      422,
      `${action} reason must be at most 500 characters`,
    );
  }
  return normalized;
}

// The runtime the parent run resolved at start (#516). A null-runtime row predates the column and
// — by that era's invariant (Workflow always launched Claude Code) — was a claude-code run;
// normalizeCodingAgent maps that (and any unrecognized value) to claude-code while passing every
// known runtime (codex, grok) through, so a grok run's steps stay on grok instead of collapsing to
// claude (#1521).
function runRuntime(run: S.WorkflowRunRow): CodingAgent {
  return normalizeCodingAgent(run.runtime);
}

function runContractLanguage(run: S.WorkflowRunRow): WorkflowContractLanguage {
  return run.contract_language === "ja" ? "ja" : "en";
}

// The model the parent run resolved at start. When the row pinned no model (an old run, or a start
// that passed none), fall back to the repo's effective Coding agent config (#1532): the repo
// override's model when its toggle is on and its runtime matches this run's, else the application
// default for this run's runtime. This keeps the fallback aligned with the effective config a fresh
// run resolves at start rather than reading the raw application default directly.
function runModel(run: S.WorkflowRunRow): string {
  const pinned = run.model?.trim();
  if (pinned) return pinned;
  const runtime = runRuntime(run);
  const repo = S.getRepoById(run.repo_id);
  if (repo) {
    const effective = effectiveRepoAgentConfigFor(repo);
    if (effective.runtime === runtime) return effective.model;
  }
  return agentModel(runtime);
}

function runJSON(run: S.WorkflowRunRow): WorkflowRunUpdateResult["run"] {
  return {
    id: run.id,
    workflow_id: run.workflow_id,
    status: run.status,
    current_step: run.current_step,
    rework_count: run.rework_count,
    needs_human_reason: run.needs_human_reason,
    parent_session_id: run.parent_session_id,
    step_sessions_json: run.step_sessions_json,
    active_step: run.active_step,
    active_session_id: run.active_session_id,
  };
}

function workflowStep(value: string): WorkflowStep {
  if (!WORKFLOW_STEPS.includes(value as WorkflowStep)) {
    throw new ServiceError(
      422,
      `invalid step "${value}" (expected one of: ${WORKFLOW_STEPS.join(", ")})`,
    );
  }
  return value as WorkflowStep;
}

function validateWorkflowStepAgentName(
  agentName: string,
  runId: number,
  step: WorkflowStep,
): void {
  const paneAgent = parseWorkflowHerdrAgentName(agentName);
  if (
    paneAgent?.kind !== "step" ||
    paneAgent.runId !== runId ||
    paneAgent.step !== step
  ) {
    throw new ServiceError(422, "invalid Workflow step agent name");
  }
}

function workflowRunOr404(id: number): S.WorkflowRunRow {
  const run = S.getWorkflowRun(id);
  if (!run) throw new ServiceError(404, "Workflow run not found");
  return run;
}

function workflowRunWorktree(input: {
  repo: S.Repo;
  prNumber: number;
  headRef: string;
}): string {
  const identity = resolveWorktreeIdentity(input.headRef, input.prNumber);
  return identity.scheme === "legacy-issue"
    ? legacyWorktreePath(worktreeRoot(), input.repo.full_name, identity.number)
    : prWorktreePath(worktreeRoot(), input.repo.full_name, identity.number);
}

// The pointers handed to a step child at launch. Execute gets domain references it pulls
// itself over the lh CLI; Verify gets the fixed (issue, base SHA, head SHA) triple it reviews,
// plus the PR number solely as its review submission target. No content is synthesized.
function buildStepPointers(input: {
  repoName: string;
  run: S.WorkflowRunRow;
  language: WorkflowContractLanguage;
  step: WorkflowStep;
  reviewId?: number;
  baseSha?: string;
  headSha?: string;
}): WorkflowInputPointer[] {
  const repo = inlineText(input.repoName);
  switch (input.step) {
    case "execute":
      return [
        { label: "repo", value: repo },
        { label: "issue", value: `#${input.run.issue_number}` },
        { label: "pr", value: `#${input.run.pr_number}` },
        ...(input.reviewId !== undefined
          ? [{ label: "address review", value: `#${input.reviewId}` }]
          : []),
      ];
    case "verify": {
      const messages = workflowMessages(input.language);
      return [
        { label: "repo", value: repo },
        { label: "issue", value: `#${input.run.issue_number}` },
        { label: "base sha", value: input.baseSha ?? "" },
        { label: "head sha", value: input.headSha ?? "" },
        {
          label: `review submission target (${messages.reviewSubmissionInstruction})`,
          value: `pr #${input.run.pr_number}`,
        },
      ];
    }
  }
}

// Validate a rework launch's review pointer: only Execute launches take one (the
// "address review #<id>" pointer), and it must reference a review on the run's PR.
function resolveReworkReview(
  prIssueId: number,
  step: WorkflowStep,
  reviewId: number | undefined,
): number | undefined {
  if (reviewId === undefined) return undefined;
  if (step !== "execute") {
    throw new ServiceError(
      422,
      "a review pointer applies to Execute launches only",
    );
  }
  if (!S.listReviews(prIssueId).some((review) => review.id === reviewId)) {
    throw new ServiceError(404, `review #${reviewId} not found on the run PR`);
  }
  return reviewId;
}

function reviewSubmittedEvent(
  events: S.EventRow[],
  reviewId: number,
): S.EventRow | undefined {
  return events.find((event) => {
    if (event.type !== "workflow_run.review_submitted") return false;
    const payload = JSON.parse(event.payload) as { review_id?: unknown };
    return payload.review_id === reviewId;
  });
}

// The step this run had launched / activated last at the time `eventId` was recorded, from the
// run's own event trail (`eventsForWorkflowRun` returns it in id order).
function activeStepAtEvent(
  events: S.EventRow[],
  eventId: number,
): WorkflowStep | null {
  let active: WorkflowStep | null = null;
  for (const event of events) {
    if (event.id > eventId) break;
    if (
      event.type !== "workflow_step.launched" &&
      event.type !== "workflow_run.updated"
    ) {
      continue;
    }
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    const step =
      event.type === "workflow_step.launched"
        ? payload.step
        : payload.transition === "activate_step"
          ? payload.active_step
          : null;
    if (step === "execute" || step === "verify") active = step;
  }
  return active;
}

// Scope a review to this run by parsing its author back to a `verifier #<run>-<seq>` agent name.
// A Verify child that posts without a LoopHub-registered session id is recorded as `unknown` (the
// `actorFor()` fallback), so its author carries no run information (#1849). Those reviews are owned
// by the run whose run-scoped `workflow_run.review_submitted` event carries them, and only when
// that submission happened while the run was on Verify — an unattributed review posted while
// Execute is running is somebody else's and stays out-of-band.
function isWorkflowRunVerifyReview(
  review: S.ReviewRow,
  runId: number,
  runEvents: S.EventRow[],
): boolean {
  const agent = parseWorkflowHerdrAgentName(review.author);
  if (agent) {
    return (
      agent.kind === "step" && agent.step === "verify" && agent.runId === runId
    );
  }
  if (review.author !== UNKNOWN_ACTOR) return false;
  const submitted = reviewSubmittedEvent(runEvents, review.id);
  return (
    submitted !== undefined &&
    activeStepAtEvent(runEvents, submitted.id) === "verify"
  );
}

// The latest substantive review submitted by this run's own Verify children. Reviews from other
// runs on the same PR (or from humans) never drive this run's transitions — old runs' data cannot
// gate a new run.
function latestWorkflowRunReview(
  repoId: number,
  prIssueId: number,
  runId: number,
): S.ReviewRow | null {
  const reviews = S.listReviews(prIssueId);
  const runEvents = S.eventsForWorkflowRun(repoId, runId);
  for (let i = reviews.length - 1; i >= 0; i--) {
    const review = reviews[i];
    if (review.event !== "PASS" && review.event !== "REQUEST_CHANGES") continue;
    if (isWorkflowRunVerifyReview(review, runId, runEvents)) return review;
  }
  return null;
}

function reviewObservation(
  review: S.ReviewRow | null,
): WorkflowLatestReviewState | null {
  if (!review) return null;
  return {
    id: review.id,
    event: review.event === "PASS" ? "pass" : "request_changes",
    headSha: review.head_sha,
  };
}

function turnDoneObservation(
  repoId: number,
  runId: number,
  review: S.ReviewRow | null,
): {
  at: string | null;
  forActiveExecute: boolean;
  verifyLaunchedAfter: boolean;
} {
  const events = S.eventsForWorkflowRun(repoId, runId);
  const turnDone = events.findLast(
    (event) => event.type === "workflow_run.turn_done",
  );
  if (!turnDone) {
    return { at: null, forActiveExecute: false, verifyLaunchedAfter: true };
  }
  // Whether the Verify child now marked active was launched for this turn done. A Verify launched
  // before it reviewed older work and cannot report on the HEAD the turn done announced (#1857).
  const verifyLaunched = events.findLast((event) => {
    if (event.type !== "workflow_step.launched") return false;
    return (JSON.parse(event.payload) as { step?: unknown }).step === "verify";
  });
  const verifyLaunchedAfter =
    verifyLaunched !== undefined && verifyLaunched.id > turnDone.id;
  const executeRound = events.findLast((event) => {
    if (
      event.type !== "workflow_step.launched" &&
      event.type !== "workflow_run.updated"
    ) {
      return false;
    }
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    return event.type === "workflow_step.launched"
      ? payload.step === "execute"
      : payload.transition === "activate_step" &&
          payload.active_step === "execute";
  });
  if (!executeRound) {
    return {
      at: turnDone.created_at,
      forActiveExecute: false,
      verifyLaunchedAfter,
    };
  }
  const reviewSubmitted = review
    ? events.findLast((event) => {
        if (event.type !== "workflow_run.review_submitted") return false;
        return (
          (JSON.parse(event.payload) as { review_id?: unknown }).review_id ===
          review.id
        );
      })
    : undefined;
  const afterReview = !review
    ? true
    : reviewSubmitted
      ? turnDone.id > reviewSubmitted.id
      : turnDone.created_at > review.created_at;
  return {
    at: turnDone.created_at,
    forActiveExecute: turnDone.id > executeRound.id && afterReview,
    verifyLaunchedAfter,
  };
}

function workflowWakeObservation(
  prIssueId: number,
  event: LoopEvent | null,
  requiresChanges: boolean | undefined,
  // A `--watch` wake carries no parent decision yet. GitHub feedback is the one wake that needs one,
  // so the watch reconciles from state alone and the parent re-runs `next --event` with its
  // `--requires-changes` verdict after reading the reference.
  watched: boolean,
): WorkflowWakeInput | null {
  if (!event) {
    if (requiresChanges !== undefined) {
      throw new ServiceError(422, "requiresChanges requires a workflow event");
    }
    return null;
  }
  const eventId = event.id;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === "workflow_run.escalated") {
    if (typeof payload.reason !== "string") {
      throw new ServiceError(
        422,
        `workflow event #${eventId} has no escalation reason`,
      );
    }
    return { kind: "execute_escalation", reason: payload.reason };
  }
  if (event.type === "workflow_run.github_event") {
    if (requiresChanges === undefined) {
      if (watched) return null;
      throw new ServiceError(
        422,
        "GitHub feedback requires a parent changes decision",
      );
    }
    return requiresChanges ? { kind: "github_feedback" } : null;
  }
  if (requiresChanges !== undefined) {
    throw new ServiceError(
      422,
      "requiresChanges is only valid for GitHub feedback",
    );
  }
  if (event.type === "workflow_run.review_submitted") {
    const reviewId = payload.review_id;
    if (typeof reviewId !== "number") {
      throw new ServiceError(
        422,
        `workflow event #${eventId} has no review id`,
      );
    }
    if (!S.listReviews(prIssueId).some((review) => review.id === reviewId)) {
      throw new ServiceError(
        404,
        `review #${reviewId} not found on workflow run PR`,
      );
    }
    // Review ownership and whether it remains unaddressed are observed by status. The event only
    // wakes reconciliation, so both run-owned and out-of-band reviews use the current status.
    return null;
  }
  return null;
}

function outOfBandReviewVerdict(
  review: S.ReviewRow,
  runId: number,
  runEvents: S.EventRow[],
): WorkflowOutOfBandReviewWire["verdict"] | null {
  if (isWorkflowRunVerifyReview(review, runId, runEvents)) return null;
  if (review.event === "FEEDBACK") return "feedback";
  if (review.event === "REQUEST_CHANGES") return "request_changes";
  return null;
}

async function unaddressedOutOfBandReviews(input: {
  repo: S.Repo;
  run: S.WorkflowRunRow;
  prIssueId: number;
  worktree: string;
  currentHead: string | null;
}): Promise<WorkflowOutOfBandReviewWire[]> {
  const events = S.eventsForWorkflowRun(input.repo.id, input.run.id);
  const reviews = S.listReviews(input.prIssueId);
  const unaddressed: WorkflowOutOfBandReviewWire[] = [];
  for (const review of reviews) {
    const verdict = outOfBandReviewVerdict(review, input.run.id, events);
    if (!verdict) continue;
    const submitted = reviewSubmittedEvent(events, review.id);
    // The run-scoped event is the submission boundary. Reviews that predate this run have no such
    // event and must not be revived as new work for a later attempt on the same PR.
    if (!submitted) continue;
    const submittedPayload = JSON.parse(submitted.payload) as {
      submission_head_sha?: unknown;
    };
    const submissionHeadSha =
      typeof submittedPayload.submission_head_sha === "string"
        ? submittedPayload.submission_head_sha
        : review.head_sha;
    let addressed = false;
    for (const event of events) {
      if (event.type !== "workflow_run.turn_done" || event.id <= submitted.id) {
        continue;
      }
      const payload = JSON.parse(event.payload) as { head_sha?: unknown };
      const turnDoneHead =
        typeof payload.head_sha === "string" ? payload.head_sha : null;
      if (!submissionHeadSha || !turnDoneHead || !input.currentHead) continue;
      const advancedAtTurn = await isHeadAheadOfReview(
        input.worktree,
        {
          id: review.id,
          event: "request_changes",
          headSha: submissionHeadSha,
        },
        turnDoneHead,
      );
      const turnDoneHeadStillPresent =
        turnDoneHead === input.currentHead ||
        (await isHeadAheadOfReview(
          input.worktree,
          {
            id: review.id,
            event: "request_changes",
            headSha: turnDoneHead,
          },
          input.currentHead,
        ));
      if (advancedAtTurn && turnDoneHeadStillPresent) {
        addressed = true;
        break;
      }
    }
    if (!addressed) {
      unaddressed.push({ id: review.id, verdict });
    }
  }
  return unaddressed;
}

function stepActorAllowed(
  run: S.WorkflowRunRow,
  step: WorkflowStep,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  if (sessionId === run.parent_session_id) return true;
  if (S.getAgentSession(sessionId)?.agent === "me") return true;
  try {
    const sessions = JSON.parse(run.step_sessions_json) as Record<
      string,
      unknown
    >;
    return Array.isArray(sessions[step]) && sessions[step].includes(sessionId);
  } catch {
    return false;
  }
}

// Resolve a run's (worktree, base ref, latest review) and observe its progress. The git-touching
// observation lives in core/workflow-run-progress.ts; this adapter only supplies the store-derived
// inputs (review resolution stays here — see resolveReworkReview / latestWorkflowRunReview).
async function workflowRunProgress(
  repo: S.Repo,
  run: S.WorkflowRunRow,
): Promise<WorkflowRunProgress> {
  const prIssue = issueOr404(repo, run.pr_number, "pull");
  const pull = S.getPull(prIssue.id);
  if (!pull)
    throw new ServiceError(404, `pull request #${run.pr_number} not found`);
  return observeWorkflowRunProgress({
    worktree: workflowRunWorktree({
      repo,
      prNumber: run.pr_number,
      headRef: pull.head_ref,
    }),
    baseBranch: pull.base_ref,
    latestReview: reviewObservation(
      latestWorkflowRunReview(repo.id, prIssue.id, run.id),
    ),
  });
}

// Build the issue / PR detail display state (#1008) from a run row. The row is the display-state
// source (workflow design: CLI / UI); this does not re-derive step-completion truth (that is
// `workflow step status`).
// `latest_review` gives the human-readable reason behind a rework / block.
function workflowRunState(
  repo: S.Repo,
  run: S.WorkflowRunRow,
): WorkflowRunStateWire {
  const workflowName = run.workflow_id
    ? (S.getWorkflowById(run.workflow_id)?.name ?? null)
    : null;
  const prIssue = S.getIssue(repo.id, run.pr_number);
  const review = prIssue
    ? latestWorkflowRunReview(repo.id, prIssue.id, run.id)
    : null;
  const latestReview: WorkflowRunReviewSummaryWire | null = review
    ? {
        id: review.id,
        event: review.event === "PASS" ? "pass" : "request_changes",
        summary: review.body,
        findings_count: prIssue
          ? S.listReviewComments(prIssue.id).filter(
              (comment) => comment.review_id === review.id,
            ).length
          : 0,
      }
    : null;
  const pull = prIssue ? S.getPull(prIssue.id) : null;
  const observedReview = reviewObservation(review);
  const reviewFresh = Boolean(
    observedReview?.headSha &&
      pull?.head_sha &&
      observedReview.headSha === pull.head_sha,
  );
  const verificationStatus =
    observedReview?.event === "pass" && reviewFresh
      ? "verified"
      : observedReview?.event === "pass"
        ? "stale"
        : "unverified";
  return workflowRunStateJSON({
    run,
    workflowName,
    latestReview,
    verificationStatus,
  });
}

function assertParentActor(
  run: S.WorkflowRunRow,
  sessionId: string | null | undefined,
) {
  if (!run.parent_session_id || sessionId !== run.parent_session_id) {
    throw new ServiceError(
      403,
      "Workflow run updates must be issued by the parent session",
    );
  }
}

// Run-state updates accept the parent session or a human CLI session (agent "me", same precedent as
// stepActorAllowed). The human path exists so a run whose parent session died while waiting for a
// human (#1307) can still be cancelled — otherwise it would stay `running` forever and permanently
// block workflow deletion.
function assertRunUpdateActor(
  run: S.WorkflowRunRow,
  sessionId: string | null | undefined,
) {
  if (sessionId && S.getAgentSession(sessionId)?.agent === "me") return;
  assertParentActor(run, sessionId);
}

type WorkflowRunTransition =
  | "complete"
  | "advance_to_verify"
  | "activate_step"
  | "await_human"
  | "resume_after_human"
  | "request_rework";

function lifecycleRun(
  name: string,
  runId: number,
  sessionId: string | null | undefined,
): { repo: S.Repo; run: S.WorkflowRunRow } {
  const repo = repoOr404(name);
  ensureWritable(repo);
  const run = workflowRunOr404(runId);
  if (run.repo_id !== repo.id) {
    throw new ServiceError(404, "Workflow run not found for repo");
  }
  assertRunUpdateActor(run, sessionId);
  return { repo, run };
}

function assertRunningLifecycle(run: S.WorkflowRunRow): void {
  if (run.status !== "running") {
    throw new ServiceError(409, `Workflow run is ${run.status}`);
  }
}

function assertAutomaticProgressAllowed(run: S.WorkflowRunRow): void {
  assertRunningLifecycle(run);
  if (run.needs_human_reason !== null) {
    throw new ServiceError(
      409,
      `Workflow run is waiting for a human: ${run.needs_human_reason}`,
    );
  }
}

function updateRunLifecycle(
  run: S.WorkflowRunRow,
  patch: {
    status?: string;
    currentStep?: WorkflowStep;
    reworkCount?: number;
    needsHumanReason?: string | null;
    activeStep?: WorkflowStep | null;
    activeSessionId?: string | null;
  },
  transition: WorkflowRunTransition,
  sessionId: string | null | undefined,
): WorkflowRunUpdateResult {
  const updated = S.updateWorkflowRun(run.id, patch);
  if (!updated) throw new ServiceError(404, "Workflow run not found");
  S.emitEvent(updated.repo_id, "workflow_run.updated", actorFor(sessionId), {
    id: updated.id,
    transition,
    status: updated.status,
    current_step: updated.current_step,
    rework_count: updated.rework_count,
    ...(transition === "await_human" || transition === "resume_after_human"
      ? { needs_human_reason: updated.needs_human_reason }
      : {}),
    ...(transition === "activate_step"
      ? {
          active_step: updated.active_step,
          active_session_id: updated.active_session_id,
        }
      : {}),
    issue_number: updated.issue_number,
    pr_number: updated.pr_number,
  });
  return { run: runJSON(updated) };
}

export const workflowRuns = {
  async start(
    name: string,
    input: {
      issue: number;
      workflow?: string;
      workflowId?: number;
      auto?: boolean;
      // Runtime + model the CLI resolved for the parent (#516). Persisted on the run row so every
      // step inherits the same values. Omitted => claude-code + the agent's config default model.
      runtime?: CodingAgent;
      model?: string | null;
      lockPid?: number;
    },
    sessionId: string = randomUUID(),
  ): Promise<WorkflowRunStartResult> {
    const r = repoOr404(name);
    ensureWritable(r);
    const workflow = workflowByInput(input);
    const issue = issueOr404(r, input.issue, "issue");
    const runtime: CodingAgent = input.runtime ?? "claude-code";
    const contractLanguage = workflowContractLanguage();

    S.registerAgentSession(
      sessionId,
      "lh-workflow",
      sessionId,
      `Workflow #${issue.number} ${issue.title}`,
      runtime,
      "dev",
    );

    const opened = await dev.openPr(
      r.full_name,
      { issue: issue.number },
      sessionId,
      { attributeSession: false },
    );
    const prIssue = issueOr404(r, opened.number, "pull");
    const pull = S.getPull(prIssue.id);
    if (!pull) {
      throw new ServiceError(404, `pull request #${opened.number} not found`);
    }
    assertExistingLocalBranch(r.local_path, pull.base_ref, "PR base ref");

    const identity = resolveWorktreeIdentity(pull.head_ref, opened.number);
    const root = worktreeRoot();
    const wtPath =
      identity.scheme === "legacy-issue"
        ? legacyWorktreePath(root, r.full_name, identity.number)
        : prWorktreePath(root, r.full_name, identity.number);

    const lockPath = devLockPath(configDir(), r.full_name, opened.number);
    const claim = acquireDevLock(
      lockPath,
      {
        pid: input.lockPid ?? process.pid,
        pr: opened.number,
        worktree: wtPath,
        sessionId,
        startedAt: new Date().toISOString(),
      },
      pidAlive,
    );
    if (!claim.ok) {
      throw new ServiceError(
        409,
        `PR #${opened.number} is already being worked on by another dev session (pid ${claim.held.pid}, since ${claim.held.startedAt})`,
      );
    }

    try {
      await provisionWorktree({
        repoPath: r.local_path,
        fullName: r.full_name,
        defaultBranch: pull.base_ref,
        worktreeRoot: root,
        pr: identity.number,
        scheme: identity.scheme,
        headRef: pull.head_ref,
        allowCreatingConventionBranch: shouldCreateMissingConventionBranch({
          issueAttempt: opened,
          headPendingCreation: pull.head_pending_creation === 1,
          baseSha: pull.base_sha,
        }),
        baseSha: pull.base_sha ?? undefined,
      });
      if (pull.head_pending_creation === 1) {
        S.setHeadSha(prIssue.id, await worktreeHead(wtPath));
      }

      dev.attachSession(r.full_name, opened.number, sessionId);

      const costIncrementUsd = devCostLimitUsd();

      const run = S.createWorkflowRun({
        workflowId: workflow.id,
        repoId: r.id,
        issueNumber: issue.number,
        prNumber: opened.number,
        status: "running",
        currentStep: "execute",
        autoMode: input.auto,
        runtime,
        model: input.model?.trim() || null,
        contractLanguage,
        parentSessionId: sessionId,
        costIncrementUsd,
        costLimitUsd: costIncrementUsd,
      });

      const systemPromptPath = writeParentContract(
        run.id,
        renderWorkflowContract(
          {
            template: workflowContractText("parent", contractLanguage),
            step: "parent",
            worktreePath: wtPath,
            baseBranch: pull.base_ref,
          },
          contractLanguage,
        ),
      );

      S.emitEvent(r.id, "workflow_run.started", actorFor(sessionId), {
        id: run.id,
        workflow_id: workflow.id,
        issue_number: issue.number,
        pr_number: opened.number,
        session_id: sessionId,
      });

      return {
        run: {
          id: run.id,
          workflow_id: run.workflow_id,
          status: run.status,
          current_step: run.current_step,
          rework_count: run.rework_count,
          parent_session_id: run.parent_session_id,
        },
        workflow: { id: workflow.id, name: workflow.name },
        issue: { number: issue.number, title: issue.title },
        pr: { number: opened.number, created: opened.created },
        session_id: sessionId,
        worktree: wtPath,
        base_ref: pull.base_ref,
        head_ref: pull.head_ref,
        lock_path: lockPath,
        parent: {
          system_prompt_path: systemPromptPath,
          user_prompt: parentUserPrompt(
            {
              runId: run.id,
              repoName: r.full_name,
              workflowName: workflow.name,
              issueNumber: issue.number,
              prNumber: opened.number,
              baseRef: pull.base_ref,
            },
            contractLanguage,
          ),
        },
      };
    } catch (e) {
      removeDevLock(lockPath);
      throw e;
    }
  },

  async advanceToVerify(
    name: string,
    input: { run: number },
    sessionId?: string | null,
  ): Promise<WorkflowRunUpdateResult> {
    const { repo, run } = lifecycleRun(name, input.run, sessionId);
    assertAutomaticProgressAllowed(run);
    if (run.current_step !== "execute") {
      throw new ServiceError(
        409,
        `Workflow run cannot advance to Verify from ${run.current_step}`,
      );
    }
    const progress = await workflowRunProgress(repo, run);
    if (!progress.steps.execute.complete) {
      throw new ServiceError(
        409,
        `Workflow Execute is incomplete: ${progress.steps.execute.missing.join("; ")}`,
      );
    }
    return updateRunLifecycle(
      run,
      {
        currentStep: "verify",
        activeStep: null,
        activeSessionId: null,
      },
      "advance_to_verify",
      sessionId,
    );
  },

  awaitHuman(
    name: string,
    input: { run: number; reason: string },
    sessionId?: string | null,
  ): WorkflowRunUpdateResult {
    const { run } = lifecycleRun(name, input.run, sessionId);
    assertRunningLifecycle(run);
    if (run.needs_human_reason !== null) {
      throw new ServiceError(
        409,
        "Workflow run is already waiting for a human",
      );
    }
    const reason = workflowHumanReason(input.reason, "await-human");
    return updateRunLifecycle(
      run,
      { needsHumanReason: reason },
      "await_human",
      sessionId,
    );
  },

  async resumeAfterHuman(
    name: string,
    input: { run: number; step: string },
    sessionId?: string | null,
  ): Promise<WorkflowRunUpdateResult> {
    const { repo, run } = lifecycleRun(name, input.run, sessionId);
    assertRunningLifecycle(run);
    if (run.needs_human_reason === null) {
      throw new ServiceError(409, "Workflow run is not waiting for a human");
    }
    if (
      run.cost_limit_usd !== null &&
      S.hasWorkflowRunCostExceededEvent(repo.id, run.id, run.cost_limit_usd)
    ) {
      throw new ServiceError(
        409,
        "Workflow cost limit must be increased before resuming",
      );
    }
    const step = workflowStep(input.step);
    if (step === "verify") {
      // Resuming at Verify only needs something to review (head ahead of base) — a human may
      // deliberately re-verify the same head, so the execute "advanced past review" condition
      // does not apply here.
      const progress = await workflowRunProgress(repo, run);
      if (!progress.headAheadOfBase) {
        throw new ServiceError(
          409,
          "Workflow cannot resume at Verify: head equals base",
        );
      }
    }
    return updateRunLifecycle(
      run,
      {
        currentStep: step,
        reworkCount: 0,
        needsHumanReason: null,
        activeStep: null,
        activeSessionId: null,
      },
      "resume_after_human",
      sessionId,
    );
  },

  activateStep(
    name: string,
    input: { run: number; step: string; sessionId: string },
    sessionId?: string | null,
  ): WorkflowRunUpdateResult {
    const { run } = lifecycleRun(name, input.run, sessionId);
    assertAutomaticProgressAllowed(run);
    const step = workflowStep(input.step);
    if (step !== "execute") {
      throw new ServiceError(
        422,
        "Only an Execute step can be reactivated for live pane input",
      );
    }
    if (
      !workflowStepSessionIds(run.step_sessions_json, step).includes(
        input.sessionId,
      )
    ) {
      throw new ServiceError(
        422,
        "active session is not registered for the Workflow step",
      );
    }
    return updateRunLifecycle(
      run,
      { activeStep: step, activeSessionId: input.sessionId },
      "activate_step",
      sessionId,
    );
  },

  async deliver(
    name: string,
    input: { run: number; text: string },
    sessionId?: string | null,
  ): Promise<WorkflowDeliverResult> {
    const { repo, run } = lifecycleRun(name, input.run, sessionId);
    assertAutomaticProgressAllowed(run);
    const text = inlineText(input.text);
    if (!text) {
      throw new ServiceError(422, "workflow deliver requires non-empty text");
    }

    const sessionName = herdrSessionName(repo);
    const agentsOut = await runHerdr(
      "herdr",
      ["--session", sessionName, "agent", "list"],
      repo.local_path,
      { captureStdout: true, timeoutMs: 15_000 },
    );
    const latest = parseHerdrAgentList(agentsOut)
      .map((agent) => ({
        agent,
        parsed: parseWorkflowHerdrAgentName(agent.name),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          agent: ReturnType<typeof parseHerdrAgentList>[number];
          parsed: Extract<WorkflowHerdrAgent, { kind: "step" }>;
        } =>
          candidate.parsed?.kind === "step" &&
          candidate.parsed.runId === run.id &&
          candidate.parsed.step === "execute",
      )
      .sort((a, b) => b.parsed.sequence - a.parsed.sequence)[0];
    if (!latest) {
      throw new ServiceError(
        404,
        `No Execute agent found for Workflow run #${run.id}`,
      );
    }
    if (
      latest.agent.id.startsWith(NO_PANE_ID_PREFIX) ||
      !HERDR_ID.test(latest.agent.id)
    ) {
      throw new ServiceError(
        422,
        `Execute agent "${latest.agent.name}" has no valid pane_id`,
      );
    }

    const matchingSessions = workflowStepSessionIds(
      run.step_sessions_json,
      "execute",
    ).filter(
      (candidate) => S.getAgentSession(candidate)?.name === latest.agent.name,
    );
    if (matchingSessions.length !== 1) {
      throw new ServiceError(
        422,
        `Cannot resolve the registered Execute session for agent "${latest.agent.name}"`,
      );
    }
    const executeSessionId = matchingSessions[0];
    workflowRuns.activateStep(
      name,
      { run: run.id, step: "execute", sessionId: executeSessionId },
      sessionId,
    );
    await runHerdr(
      "herdr",
      ["--session", sessionName, "pane", "run", latest.agent.id, text],
      repo.local_path,
      { timeoutMs: 15_000 },
    );
    return {
      run: run.id,
      agent_name: latest.agent.name,
      pane_id: latest.agent.id,
      session_id: executeSessionId,
      text,
    };
  },

  detectCostExceeded(
    name: string,
    input: { run: number; usageSession: string },
  ): WorkflowRunCostDetectionResult {
    const repo = repoOr404(name);
    ensureWritable(repo);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== repo.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    if (run.status !== "running") {
      return {
        emitted: false,
        cost_usd: null,
        limit_usd:
          run.cost_limit_usd ?? run.cost_increment_usd ?? devCostLimitUsd(),
      };
    }
    const { incrementUsd, limitUsd, summary } = workflowRunCost(run);
    if (summary.cost_usd === null || summary.cost_usd <= limitUsd) {
      return {
        emitted: false,
        cost_usd: summary.cost_usd,
        limit_usd: limitUsd,
      };
    }
    // A hold is the outcome this event asks for, so stop re-emitting once one exists (#1844) —
    // whether `cost-hold` established it or a human is still deciding. Without this the parent
    // would replay Esc and the pane notification against a run it already interrupted.
    if (run.needs_human_reason !== null) {
      return {
        emitted: false,
        cost_usd: summary.cost_usd,
        limit_usd: limitUsd,
      };
    }
    if (
      input.usageSession !== run.parent_session_id &&
      !workflowStepSessionIds(run.step_sessions_json, "execute").includes(
        input.usageSession,
      ) &&
      !workflowStepSessionIds(run.step_sessions_json, "verify").includes(
        input.usageSession,
      )
    ) {
      throw new ServiceError(
        409,
        "usage session does not belong to Workflow run",
      );
    }
    const parentSessionId = run.parent_session_id;
    if (!parentSessionId) {
      return {
        emitted: false,
        cost_usd: summary.cost_usd,
        limit_usd: limitUsd,
      };
    }
    const event = S.emitWorkflowRunCostExceeded(
      repo.id,
      "lh-worker",
      {
        id: run.id,
        number: run.pr_number,
        pr_number: run.pr_number,
        parent_session_id: parentSessionId,
        session_id: input.usageSession,
        usage_session_id: input.usageSession,
        active_step: run.active_step,
        active_session_id: run.active_session_id,
        cost_usd: summary.cost_usd,
        limit_usd: limitUsd,
        increment_usd: incrementUsd,
        next_limit_usd: limitUsd + incrementUsd,
      },
      costReemitMs(),
    );
    return {
      emitted: event !== null,
      cost_usd: summary.cost_usd,
      limit_usd: limitUsd,
    };
  },

  increaseCostLimit(
    name: string,
    input: { run: number; expectedLimitUsd: number },
    sessionId?: string | null,
  ): WorkflowRunCostLimitIncreaseResult {
    const { repo, run } = lifecycleRun(name, input.run, sessionId);
    assertRunningLifecycle(run);
    if (
      !Number.isFinite(input.expectedLimitUsd) ||
      input.expectedLimitUsd <= 0
    ) {
      throw new ServiceError(
        422,
        "expected cost limit must be a positive number",
      );
    }
    if (run.needs_human_reason === null) {
      throw new ServiceError(409, "Workflow run is not waiting for a human");
    }
    if (run.cost_increment_usd === null || run.cost_limit_usd === null) {
      throw new ServiceError(409, "Workflow run has no persisted cost limit");
    }
    if (run.cost_limit_usd !== input.expectedLimitUsd) {
      throw new ServiceError(
        409,
        `expected cost limit $${input.expectedLimitUsd} does not match current limit $${run.cost_limit_usd}`,
      );
    }
    if (
      !S.hasWorkflowRunCostExceededEvent(
        repo.id,
        run.id,
        input.expectedLimitUsd,
      )
    ) {
      throw new ServiceError(
        409,
        `no cost exceeded event exists for limit $${input.expectedLimitUsd}`,
      );
    }
    const increased = S.increaseWorkflowRunCostLimit(
      run.id,
      input.expectedLimitUsd,
    );
    if (!increased) {
      throw new ServiceError(
        409,
        "Workflow cost limit was not increased because its state changed",
      );
    }
    S.emitEvent(
      repo.id,
      "workflow_run.cost_limit_increased",
      actorFor(sessionId),
      {
        id: run.id,
        issue_number: run.issue_number,
        pr_number: run.pr_number,
        increment_usd: run.cost_increment_usd,
        previous_limit_usd: increased.previous_limit_usd,
        current_limit_usd: increased.current_limit_usd,
      },
    );
    return {
      run: run.id,
      increment_usd: run.cost_increment_usd,
      ...increased,
    };
  },

  async requestRework(
    name: string,
    input: { run: number },
    sessionId?: string | null,
  ): Promise<WorkflowRunUpdateResult> {
    const { repo, run } = lifecycleRun(name, input.run, sessionId);
    assertAutomaticProgressAllowed(run);
    if (run.current_step !== "verify") {
      throw new ServiceError(
        409,
        `Workflow run cannot request rework from ${run.current_step}`,
      );
    }
    const progress = await workflowRunProgress(repo, run);
    if (!progress.steps.verify.complete) {
      throw new ServiceError(
        409,
        `Workflow Verify is incomplete: ${progress.steps.verify.missing.join("; ")}`,
      );
    }
    if (progress.steps.verify.latest_review?.event !== "request_changes") {
      throw new ServiceError(
        409,
        "Workflow Verify review does not request changes",
      );
    }
    if (run.rework_count >= 3) {
      throw new ServiceError(409, "Workflow rework limit reached");
    }
    return updateRunLifecycle(
      run,
      {
        currentStep: "execute",
        reworkCount: run.rework_count + 1,
        activeStep: null,
        activeSessionId: null,
      },
      "request_rework",
      sessionId,
    );
  },

  async launchStep(
    name: string,
    input: {
      run: number;
      step: string;
      note?: string;
      review?: number;
      model?: string | null;
      auto?: boolean;
      tabId?: string | null;
    },
    sessionId: string | null | undefined,
  ): Promise<WorkflowLaunchStepResult> {
    const r = repoOr404(name);
    ensureWritable(r);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    // A terminal or human-held run must not progress on its own (#1307).
    assertAutomaticProgressAllowed(run);
    assertParentActor(run, sessionId);
    const step = workflowStep(input.step);
    const childSessionId = randomUUID();
    const workflow = run.workflow_id
      ? S.getWorkflowById(run.workflow_id)
      : null;
    if (!workflow) throw new ServiceError(404, "Workflow not found");
    issueOr404(r, run.issue_number, "issue");
    const prIssue = issueOr404(r, run.pr_number, "pull");
    const pull = S.getPull(prIssue.id);
    if (!pull)
      throw new ServiceError(404, `pull request #${run.pr_number} not found`);
    const worktree = workflowRunWorktree({
      repo: r,
      prNumber: run.pr_number,
      headRef: pull.head_ref,
    });
    const reviewId = resolveReworkReview(prIssue.id, step, input.review);
    const headSha =
      step === "verify" ? await worktreeHead(worktree) : undefined;
    const baseSha =
      step === "verify" && headSha
        ? await pinnedBaseSha(worktree, pull.base_ref, headSha)
        : undefined;
    const pointers = buildStepPointers({
      repoName: r.full_name,
      run,
      language: runContractLanguage(run),
      step,
      reviewId,
      baseSha,
      headSha,
    });
    const composed = composeWorkflowLaunchPrompt(
      {
        template: stepContractForLaunch(
          step,
          workflowContractText(step, runContractLanguage(run)),
        ),
        step,
        worktreePath: worktree,
        baseBranch: pull.base_ref,
      },
      {
        pointers,
        worktreePath: ".",
        baseBranch: pull.base_ref,
        stepPrompt: workflowStepPrompt(workflow, step),
        note: input.note,
      },
      runContractLanguage(run),
    );
    const systemPromptPath = writeStepContract(
      run.id,
      step,
      composed.systemPrompt,
    );

    // The step inherits the parent run's runtime and model (#516) so the whole run stays on one
    // agent; an explicit launch-step --model override still wins when passed.
    const runtime = runRuntime(run);
    const model = input.model?.trim() || runModel(run);
    const sequence = S.reserveWorkflowRunChildSequence(
      run.id,
      nextWorkflowChildSequence(run.step_sessions_json),
    );
    if (sequence == null) throw new ServiceError(404, "Workflow run not found");
    const herdr = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: r.full_name, local_path: r.local_path },
      runId: run.id,
      step,
      sequence,
      runtime,
      sessionId: childSessionId,
      worktree,
      systemPromptPath,
      systemPrompt: composed.systemPrompt,
      userPrompt: composed.userPrompt,
      tabId: input.tabId,
      model,
      permissionMode: run.auto_mode === 1 || input.auto ? "auto" : undefined,
    });
    // Keep confirmation's validation at the persistence boundary, but also validate the generated
    // plan before the CLI can spawn it. A future naming/normalization change must fail before it can
    // leave a live child whose session metadata was never recorded.
    validateWorkflowStepAgentName(herdr.agentName, run.id, step);

    return {
      run: runJSON(run),
      step,
      agent_name: herdr.agentName,
      runtime,
      session_id: childSessionId,
      worktree,
      system_prompt_path: systemPromptPath,
      user_prompt: composed.userPrompt,
      pointers,
      head_sha: headSha,
      base_sha: baseSha,
      herdr,
    };
  },

  async closePreviousVerifyPane(
    name: string,
    input: { run: number },
    sessionId: string | null | undefined,
  ): Promise<void> {
    const r = repoOr404(name);
    ensureWritable(r);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    assertAutomaticProgressAllowed(run);
    assertParentActor(run, sessionId);

    const sessionName = herdrSessionName(r);
    const paneList = await runHerdr(
      "herdr",
      ["--session", sessionName, "pane", "list"],
      r.local_path,
      { captureStdout: true, timeoutMs: 15_000 },
    );
    const previous = parsePreviousWorkflowVerifyPane(paneList, run.id);
    if (!previous) {
      throw new ServiceError(500, "Herdr pane list returned invalid JSON");
    }
    if (!previous.paneId) return;
    await runHerdr(
      "herdr",
      ["--session", sessionName, "pane", "close", previous.paneId],
      r.local_path,
      { timeoutMs: 15_000 },
    );
  },

  confirmStepLaunch(
    name: string,
    input: {
      run: number;
      step: string;
      sessionId: string;
      agentName?: string;
      pointers: WorkflowInputPointer[];
      headSha?: string;
      note?: string;
    },
    actorSessionId?: string | null,
  ): WorkflowConfirmStepLaunchResult {
    const r = repoOr404(name);
    ensureWritable(r);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    assertParentActor(run, actorSessionId);
    const step = workflowStep(input.step);
    const issue = issueOr404(r, run.issue_number, "issue");
    const prIssue = issueOr404(r, run.pr_number, "pull");
    const sessionId = input.sessionId;
    if (input.agentName)
      validateWorkflowStepAgentName(input.agentName, run.id, step);
    S.registerAgentSession(
      sessionId,
      "workflow-step",
      sessionId,
      input.agentName ?? `Workflow ${step} run #${run.id}`,
      runRuntime(run),
      "workflow-step",
    );
    S.linkSession(sessionId, prIssue.id);
    const withSession = S.appendWorkflowRunStepSession(run.id, step, sessionId);
    if (!withSession) throw new ServiceError(404, "Workflow run not found");
    const withActive = S.updateWorkflowRun(run.id, {
      activeStep: step,
      activeSessionId: sessionId,
    });
    if (!withActive) throw new ServiceError(404, "Workflow run not found");
    if (step === "verify") {
      if (!input.headSha || !/^[0-9a-f]{40,64}$/u.test(input.headSha)) {
        throw new ServiceError(
          422,
          "confirmed Verify launch requires a commit SHA",
        );
      }
    }
    const messages = workflowMessages(runContractLanguage(run));
    const handoffBody = [
      messages.handoffLaunchIntro(step, run.id),
      "",
      messages.inputsHeading,
      ...input.pointers.map(
        (pointer) => `- ${pointer.label}: ${pointer.value}`,
      ),
      ...(input.note?.trim()
        ? ["", messages.handoffParentNoteHeading, input.note.trim()]
        : []),
    ].join("\n");
    const handoff = S.createHandoff({
      repoId: r.id,
      prId: prIssue.id,
      issueId: issue.id,
      sessionId: run.parent_session_id,
      phase: step,
      direction: "down",
      fromRole: "parent",
      toRole: `${step}-step`,
      body: handoffBody,
      hash: createHash("sha256").update(handoffBody).digest("hex"),
      summary: messages.handoffSummary(step),
    });
    S.emitEvent(r.id, "handoff.recorded", actorFor(run.parent_session_id), {
      number: run.pr_number,
      pr_number: run.pr_number,
      issue_number: run.issue_number,
      id: handoff.id,
      seq: handoff.seq,
      phase: step,
      direction: "down",
    });
    S.emitEvent(
      r.id,
      "workflow_step.launched",
      actorFor(run.parent_session_id),
      {
        id: run.id,
        step,
        session_id: sessionId,
        handoff_id: handoff.id,
        // Both issue / PR numbers so issue & PR detail refresh their run-state query precisely (#1008).
        issue_number: run.issue_number,
        pr_number: run.pr_number,
      },
    );
    return { run: runJSON(withActive), session_id: sessionId };
  },

  // The Execute child's payload-less turn-done declaration. It is a timing signal only: the
  // engine records the fact as an event, and the parent then observes HEAD / review state (via
  // its event cursor and step status) before deciding any transition. The declaration never
  // carries content and never substitutes for domain truth.
  async turnDone(
    name: string,
    input: { run: number },
    sessionId?: string | null,
  ): Promise<WorkflowTurnDoneResult> {
    const r = repoOr404(name);
    ensureWritable(r);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id)
      throw new ServiceError(404, "Workflow run not found for repo");
    if (run.status !== "running")
      throw new ServiceError(422, `Workflow run is ${run.status}`);
    if (!stepActorAllowed(run, "execute", sessionId)) {
      throw new ServiceError(
        403,
        "Workflow turn done must be declared by a launched Execute session",
      );
    }
    const prIssue = issueOr404(r, run.pr_number, "pull");
    const pull = S.getPull(prIssue.id);
    if (!pull)
      throw new ServiceError(404, `pull request #${run.pr_number} not found`);
    const headSha = await worktreeHead(
      workflowRunWorktree({
        repo: r,
        prNumber: run.pr_number,
        headRef: pull.head_ref,
      }),
    );
    const event = S.emitEvent(
      r.id,
      "workflow_run.turn_done",
      actorFor(sessionId),
      {
        id: run.id,
        // Both issue / PR numbers so issue & PR detail refresh their run-state query precisely
        // (#1008); `number` lets the generic pub/sub notify line name the PR.
        number: run.pr_number,
        issue_number: run.issue_number,
        pr_number: run.pr_number,
        // The worker's pub/sub delivery filters turn-done notifications to the run's own parent
        // pane by this session id (same pattern as workflow_run.github_event).
        parent_session_id: run.parent_session_id,
        session_id: sessionId ?? null,
        head_sha: headSha,
      },
    );
    return { run: run.id, event_id: event.id };
  },

  // The Execute child's escalation declaration mirrors turnDone: it records a run-scoped fact for
  // the worker to deliver to the parent, but does not mutate lifecycle state. The parent reads the
  // event reason and applies the existing await-human transition.
  escalate(
    name: string,
    input: { run: number; reason: string },
    sessionId?: string | null,
  ): WorkflowEscalateResult {
    const r = repoOr404(name);
    ensureWritable(r);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id)
      throw new ServiceError(404, "Workflow run not found for repo");
    if (run.status !== "running")
      throw new ServiceError(422, `Workflow run is ${run.status}`);
    if (!stepActorAllowed(run, "execute", sessionId)) {
      throw new ServiceError(
        403,
        "Workflow escalation must be declared by a launched Execute session",
      );
    }
    const reason = workflowHumanReason(input.reason, "escalate");
    const event = S.emitEvent(
      r.id,
      "workflow_run.escalated",
      actorFor(sessionId),
      {
        id: run.id,
        number: run.pr_number,
        issue_number: run.issue_number,
        pr_number: run.pr_number,
        parent_session_id: run.parent_session_id,
        session_id: sessionId ?? null,
        reason,
      },
    );
    return { run: run.id, event_id: event.id };
  },

  async stepInput(
    name: string,
    input: {
      run: number;
      step: string;
      note?: string;
      review?: number;
    },
    _sessionId?: string | null,
  ): Promise<WorkflowStepInputResult> {
    const r = repoOr404(name);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    const step = workflowStep(input.step);
    const workflow = run.workflow_id
      ? S.getWorkflowById(run.workflow_id)
      : null;
    if (!workflow) throw new ServiceError(404, "Workflow not found");
    issueOr404(r, run.issue_number, "issue");
    const prIssue = issueOr404(r, run.pr_number, "pull");
    const pull = S.getPull(prIssue.id);
    if (!pull)
      throw new ServiceError(404, `pull request #${run.pr_number} not found`);
    const worktree = workflowRunWorktree({
      repo: r,
      prNumber: run.pr_number,
      headRef: pull.head_ref,
    });
    const reviewId = resolveReworkReview(prIssue.id, step, input.review);
    const headSha =
      step === "verify" ? await worktreeHead(worktree) : undefined;
    const baseSha =
      step === "verify" && headSha
        ? await pinnedBaseSha(worktree, pull.base_ref, headSha)
        : undefined;
    const pointers = buildStepPointers({
      repoName: r.full_name,
      run,
      language: runContractLanguage(run),
      step,
      reviewId,
      baseSha,
      headSha,
    });
    const composed = composeWorkflowLaunchPrompt(
      {
        template: stepContractForLaunch(
          step,
          workflowContractText(step, runContractLanguage(run)),
        ),
        step,
        worktreePath: worktree,
        baseBranch: pull.base_ref,
      },
      {
        pointers,
        worktreePath: ".",
        baseBranch: pull.base_ref,
        stepPrompt: workflowStepPrompt(workflow, step),
        note: input.note,
      },
      runContractLanguage(run),
    );
    const systemPromptPath = writeStepContract(
      run.id,
      step,
      composed.systemPrompt,
    );
    return {
      run: runJSON(run),
      step,
      system_prompt: composed.systemPrompt,
      system_prompt_path: systemPromptPath,
      user_prompt: composed.userPrompt,
      pointers,
    };
  },

  async status(
    name: string,
    input: { run: number },
    _sessionId?: string | null,
  ): Promise<WorkflowStepStatusResult> {
    const r = repoOr404(name);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    const progress = await workflowRunProgress(r, run);
    const prIssue = issueOr404(r, run.pr_number, "pull");
    const latestReview = latestWorkflowRunReview(r.id, prIssue.id, run.id);
    const turnDone = turnDoneObservation(r.id, run.id, latestReview);
    const pull = S.getPull(prIssue.id);
    if (!pull)
      throw new ServiceError(404, `pull request #${run.pr_number} not found`);
    const worktree = workflowRunWorktree({
      repo: r,
      prNumber: run.pr_number,
      headRef: pull.head_ref,
    });
    const pendingEffect = S.pendingWorkflowEventEffect(run.id);
    const pendingEffectReceipt: WorkflowPendingEffectReceiptWire | null =
      pendingEffect
        ? {
            event_id: pendingEffect.event_id,
            effect: pendingEffect.effect,
            status: "pending",
            claimed_at: pendingEffect.created_at,
          }
        : null;
    const unaddressedReviews = await unaddressedOutOfBandReviews({
      repo: r,
      run,
      prIssueId: prIssue.id,
      worktree,
      currentHead: progress.currentHead,
    });
    const costIncrementUsd = run.cost_increment_usd ?? devCostLimitUsd();
    return {
      run: run.id,
      current_step: run.current_step,
      status: run.status,
      active_step: run.active_step,
      rework_count: run.rework_count,
      rework_limit: WORKFLOW_REWORK_LIMIT,
      needs_human_reason: run.needs_human_reason,
      awaiting_human: run.needs_human_reason !== null,
      pending_effect_receipt: pendingEffectReceipt,
      unaddressed_out_of_band_reviews: unaddressedReviews,
      cost_increment_usd: costIncrementUsd,
      cost_limit_usd: run.cost_limit_usd ?? costIncrementUsd,
      head_sha: progress.currentHead,
      head_ahead_of_base: progress.headAheadOfBase,
      head_ahead_of_latest_review: progress.headAheadOfLatestReview,
      merge_conflict: progress.mergeConflict,
      pr_merged: pull.merged === 1,
      last_turn_done_at: turnDone.at,
      turn_done_for_active_execute: turnDone.forActiveExecute,
      verify_launched_after_turn_done: turnDone.verifyLaunchedAfter,
      steps: progress.steps,
    };
  },

  // Advise the parent's next action from observed state. With `watch`, the call blocks on the run's
  // next event before observing, so the parent's whole loop is this one command: no cursor to carry,
  // no separate status observation, and no event delivery protocol.
  async next(
    name: string,
    input: {
      run: number;
      event?: number;
      note?: string;
      requiresChanges?: boolean;
      watch?: boolean;
    },
    sessionId?: string | null,
  ): Promise<WorkflowNextResult> {
    const externalInputs = [
      input.event !== undefined,
      input.note !== undefined,
      input.watch === true,
    ].filter(Boolean).length;
    if (externalInputs > 1) {
      throw new ServiceError(
        422,
        "workflow next accepts either watch, event, or note",
      );
    }
    const r = repoOr404(name);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    let wakeEvent: LoopEvent | null = null;
    // A run that already reached a terminal status has no further event worth waiting for; blocking
    // would leave the caller parked forever instead of returning the terminal action once.
    if (input.watch && run.status === "running") {
      wakeEvent = await workflowWatch.waitForEvent({
        repo: name,
        run: run.id,
        since: run.event_cursor,
      });
      // Move the cursor before observing: this wake is spent either way, and reconciliation reads
      // the state the event produced rather than the event itself.
      S.advanceWorkflowRunEventCursor(run.id, wakeEvent.id);
    } else if (input.event !== undefined) {
      const row = S.eventsForWorkflowRun(r.id, run.id).find(
        (candidate) => candidate.id === input.event,
      );
      if (!row) {
        throw new ServiceError(
          404,
          `workflow event #${input.event} not found for run #${run.id}`,
        );
      }
      wakeEvent = formatEvent(row, name);
    }
    const observedState = await workflowRuns.status(name, input, sessionId);
    const prIssue = issueOr404(r, run.pr_number, "pull");
    // Terminal condition (#1808): once the linked PR is merged there is nothing left to reconcile.
    // Record it from the observation rather than from the merge itself — that keeps the run
    // lifecycle owned by this service, makes every merge route land on the same result (the PR's
    // own `merged` column is the fact), and covers the wake path too: a watcher that was already
    // blocked when the merge landed records the completion on the wake that follows. A completed
    // run is no longer a `running` target for cost detection, so no further cost-exceeded edge can
    // fire for it.
    const completedNow =
      observedState.pr_merged && S.getWorkflowRun(run.id)?.status === "running"
        ? updateRunLifecycle(
            run,
            { status: "completed" },
            "complete",
            sessionId,
          ).run.status
        : null;
    const observed =
      completedNow === null
        ? observedState
        : { ...observedState, status: completedNow };
    const action = reconcileWorkflow({
      status: observed.status,
      prMerged: observed.pr_merged,
      currentStep: workflowStep(observed.current_step),
      activeStep:
        observed.active_step === null
          ? null
          : workflowStep(observed.active_step),
      needsHumanReason: observed.needs_human_reason,
      awaitingHuman: observed.awaiting_human,
      costLimitIncreaseRequired:
        observed.needs_human_reason !== null &&
        S.hasWorkflowRunCostExceededEvent(
          r.id,
          run.id,
          observed.cost_limit_usd,
        ),
      reworkCount: observed.rework_count,
      reworkLimit: observed.rework_limit,
      pendingEffectReceipt: observed.pending_effect_receipt,
      unaddressedOutOfBandReviews: observed.unaddressed_out_of_band_reviews,
      currentHead: observed.head_sha,
      mergeConflict: observed.merge_conflict,
      turnDoneForActiveExecute: observed.turn_done_for_active_execute,
      verifyLaunchedAfterTurnDone: observed.verify_launched_after_turn_done,
      steps: observed.steps,
      wake:
        input.note !== undefined
          ? { kind: "human_instruction" }
          : workflowWakeObservation(
              prIssue.id,
              wakeEvent,
              input.requiresChanges,
              input.watch === true,
            ),
    });
    return { ...action, observed, event: wakeEvent };
  },

  // Display state for issue / PR detail. Verification is derived from the same current HEAD versus
  // pinned review comparison as `workflow step status`; it is not persisted separately.
  stateForIssue(
    name: string,
    input: { issue: number },
    _sessionId?: string | null,
  ): WorkflowRunStateWire | null {
    const r = repoOr404(name);
    const run = S.latestWorkflowRunForIssue(r.id, input.issue);
    return run ? workflowRunState(r, run) : null;
  },

  stateForPull(
    name: string,
    input: { pull: number },
    _sessionId?: string | null,
  ): WorkflowRunStateWire | null {
    const r = repoOr404(name);
    const run = S.latestWorkflowRunForPull(r.id, input.pull);
    return run ? workflowRunState(r, run) : null;
  },

  // On-demand audit history for the PR detail dialog. The store query matches the persisted run id,
  // never just the PR number, so successive runs on one PR remain isolated.
  history(
    name: string,
    input: { run: number },
    _sessionId?: string | null,
  ): WorkflowRunHistoryEventWire[] {
    const r = repoOr404(name);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    return S.eventsForWorkflowRun(r.id, run.id).map((event) => {
      let handoffId: number | null = null;
      try {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        handoffId =
          typeof payload.handoff_id === "number" ? payload.handoff_id : null;
      } catch {
        // Malformed legacy payloads remain visible without launch input.
      }
      const handoff = handoffId === null ? null : S.getHandoffById(handoffId);
      const input =
        handoff?.repo_id === r.id && handoff.body !== null
          ? handoff.body
          : null;
      return workflowRunHistoryEventJSON(event, input);
    });
  },
};
