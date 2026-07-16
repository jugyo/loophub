import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  agentModel,
  type CodingAgent,
  configDir,
  devCostLimitUsd,
  worktreeRoot,
} from "../config.ts";
import {
  acquireDevLock,
  devLockPath,
  pidAlive,
  removeDevLock,
} from "../dev-lock.ts";
import { git } from "../git.ts";
import { resolveWorktreeIdentity } from "../resume.ts";
import type {
  WorkflowRunHistoryEventWire,
  WorkflowRunReviewSummaryWire,
  WorkflowRunStateWire,
} from "../serialize.ts";
import { parseHerdrAgentPlacements } from "../terminal/herdr-status.ts";
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
  nextWorkflowChildSequence,
  parseWorkflowHerdrAgentName,
  workflowStepSessionIds,
} from "../workflow/herdr-agents.ts";
import {
  evaluateWorkflowSteps,
  type WorkflowLatestReviewState,
  type WorkflowStepStatuses,
} from "../workflow/steps.ts";
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
import { inbox } from "./inbox.ts";
import {
  actorFor,
  assertExistingLocalBranch,
  ensureWritable,
  issueOr404,
  repoOr404,
  S,
  ServiceError,
  workflowRunHistoryEventJSON,
  workflowRunStateJSON,
} from "./shared.ts";

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
  };
};

export type WorkflowRunCostLimitResult = WorkflowRunUpdateResult & {
  action: "stopped" | "skipped";
  reason: "over_limit" | "under_limit" | "unknown_cost" | "already_stopped";
  cost_usd: number | null;
  limit_usd: number;
  stopped_session_id: string | null;
  unobserved_session_ids: string[];
  unknown_cost_session_ids: string[];
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

export type WorkflowConfirmStepLaunchResult = {
  run: WorkflowRunUpdateResult["run"];
  session_id: string;
};

export type WorkflowTurnDoneResult = {
  run: number;
  event_id: number;
};

export type WorkflowEscalateResult = WorkflowTurnDoneResult;

export type WorkflowStepInputResult = {
  run: WorkflowRunUpdateResult["run"];
  step: WorkflowStep;
  system_prompt: string;
  system_prompt_path: string;
  user_prompt: string;
  pointers: WorkflowInputPointer[];
};

export type WorkflowStepStatusResult = {
  run: number;
  current_step: string;
  status: string;
  // Non-null while the run is held for a human (#1307) — surfaced here so the parent's re-check
  // and an operator's inspection see the hold instead of a plain running run.
  needs_human_reason: string | null;
  head_sha: string | null;
  head_ahead_of_base: boolean;
  // Timestamp of the latest turn-done declaration event, or null. A timing signal for the
  // parent's observation — never part of step-completion truth.
  last_turn_done_at: string | null;
  steps: WorkflowStepStatuses;
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

function runDir(runId: number): string {
  return join(configDir(), "runs", "workflow", String(runId));
}

function writeRunFile(runId: number, name: string, text: string): string {
  const dir = ensureWorkflowRunDir(runId);
  const path = join(dir, name);
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return path;
}

function writeParentContract(runId: number, text: string): string {
  return writeRunFile(runId, "parent-contract.md", text);
}

function writeStepContract(
  runId: number,
  step: WorkflowStep,
  text: string,
): string {
  return writeRunFile(runId, `${step}-contract.md`, text);
}

function ensureWorkflowRunDir(runId: number): string {
  const dir = runDir(runId);
  for (const path of [
    join(configDir(), "runs"),
    join(configDir(), "runs", "workflow"),
    dir,
  ]) {
    try {
      assertNotSymlink(path);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
      mkdirSync(path);
      assertNotSymlink(path);
    }
  }
  return dir;
}

function assertNotSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new ServiceError(
      422,
      `Workflow run path must not be a symlink: ${path}`,
    );
  }
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Strip control characters (incl. newlines) and Unicode bidi-override/isolate chars, then collapse
// whitespace, so a value shown as prose in an agent prompt cannot inject fake prompt structure or
// spoof the displayed text. Used for the human/agent-readable copies of the repo/workflow names; the
// shell-quoted forms passed to commands keep the real value. The unsafe-char class mirrors
// normalizeAgentName in core/terminal/terminal-launch.ts (C0/C1 controls + DEL + bidi controls).
function inlineText(value: string): string {
  return value
    .replace(/[\x00-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function parentUserPrompt(input: {
  runId: number;
  repoName: string;
  workflowName: string;
  issueNumber: number;
  prNumber: number;
  baseRef: string;
}): string {
  const repo = shellArg(input.repoName);
  return [
    "## Run context",
    `run: ${input.runId}`,
    `workflow: ${inlineText(input.workflowName)}`,
    `repo: ${inlineText(input.repoName)} (pass --repo ${repo} on every lh command)`,
    `issue: #${input.issueNumber}`,
    `pr: #${input.prNumber}`,
    "current step: execute",
    `worktree: . (cwd. base branch: ${input.baseRef})`,
    "",
    "## Instruction",
    "Orchestrate this run through Execute -> Verify as described in your contract.",
    `Decide every transition by observing \`lh workflow step status ${input.runId} --repo ${repo} --json\` after a turn-done or workflow-review notification; never use pane output or PR body markers.`,
    "Start now:",
    `1. Subscribe this pane to turn-done declarations: \`lh subscribe --repo ${repo} --event workflow_run.turn_done\``,
    `2. Subscribe this pane to Execute escalations: \`lh subscribe --repo ${repo} --event workflow_run.escalated\``,
    `3. Subscribe this pane to Verify review registrations: \`lh subscribe --repo ${repo} --event workflow_run.review_submitted\``,
    `4. Launch the Execute child: \`lh workflow launch-step --repo ${repo} --run ${input.runId} --step execute\``,
    "Then follow your contract's transition table, rework, and escalation for the remaining steps. Do not invoke slash-style commands.",
    "",
  ].join("\n");
}

function stepContractForLaunch(_step: WorkflowStep, template: string): string {
  return template;
}

// The runtime the parent run resolved at start (#516). A null-runtime row predates the column and
// — by that era's invariant (Workflow always launched Claude Code) — was a claude-code run.
function runRuntime(run: S.WorkflowRunRow): CodingAgent {
  return run.runtime === "codex" ? "codex" : "claude-code";
}

// The model the parent run resolved at start. A null-runtime/model row falls back to the agent's
// config default, so a step launched from an old run still gets a concrete model.
function runModel(run: S.WorkflowRunRow): string {
  return run.model?.trim() || agentModel(runRuntime(run));
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

function workflowStepPrompt(
  workflow: S.WorkflowRow,
  step: WorkflowStep,
): string {
  return workflow[`${step}_prompt` as const];
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
    case "verify":
      return [
        { label: "repo", value: repo },
        { label: "issue", value: `#${input.run.issue_number}` },
        { label: "base sha", value: input.baseSha ?? "" },
        { label: "head sha", value: input.headSha ?? "" },
        {
          label: "review submission target (do not read the PR)",
          value: `pr #${input.run.pr_number}`,
        },
      ];
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

// The latest substantive review submitted by this run's own Verify children. Scoped by parsing
// the review author back to a `verifier #<run>-<seq>` agent name, so reviews from other runs on
// the same PR (or from humans) never drive this run's transitions — old runs' data cannot gate a
// new run.
function latestWorkflowRunReview(
  prIssueId: number,
  runId: number,
): S.ReviewRow | null {
  const reviews = S.listReviews(prIssueId);
  for (let i = reviews.length - 1; i >= 0; i--) {
    const review = reviews[i];
    if (review.event !== "PASS" && review.event !== "REQUEST_CHANGES") continue;
    const agent = parseWorkflowHerdrAgentName(review.author);
    if (
      agent?.kind === "step" &&
      agent.step === "verify" &&
      agent.runId === runId
    ) {
      return review;
    }
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

function hasFreshPassingWorkflowReview(run: S.WorkflowRunRow): boolean {
  if (run.current_step !== "verify") return false;
  const prIssue = S.getIssue(run.repo_id, run.pr_number);
  if (!prIssue) return false;
  const pull = S.getPull(prIssue.id);
  const review = latestWorkflowRunReview(prIssue.id, run.id);
  return Boolean(
    pull?.head_sha &&
      review?.event === "PASS" &&
      review.head_sha === pull.head_sha,
  );
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

async function worktreeHead(worktree: string): Promise<string> {
  const result = await git(worktree, ["rev-parse", "HEAD"]);
  const sha = result.stdout.trim();
  if (result.code !== 0 || !sha) {
    throw new ServiceError(422, "could not resolve Workflow worktree HEAD");
  }
  return sha;
}

async function worktreeHeadOptional(worktree: string): Promise<string | null> {
  try {
    const result = await git(worktree, ["rev-parse", "HEAD"]);
    const sha = result.stdout.trim();
    return result.code === 0 && sha ? sha : null;
  } catch {
    return null;
  }
}

async function isHeadAheadOfBase(
  worktree: string,
  baseBranch: string,
  head: string | null,
): Promise<boolean> {
  if (!head) return false;
  try {
    const result = await git(worktree, [
      "rev-list",
      "--count",
      `${baseBranch}..${head}`,
    ]);
    return result.code === 0 && Number(result.stdout.trim()) > 0;
  } catch {
    return false;
  }
}

async function workflowRunProgress(
  repo: S.Repo,
  run: S.WorkflowRunRow,
): Promise<{
  currentHead: string | null;
  headAheadOfBase: boolean;
  steps: WorkflowStepStatuses;
}> {
  const prIssue = issueOr404(repo, run.pr_number, "pull");
  const pull = S.getPull(prIssue.id);
  if (!pull)
    throw new ServiceError(404, `pull request #${run.pr_number} not found`);
  const worktree = workflowRunWorktree({
    repo,
    prNumber: run.pr_number,
    headRef: pull.head_ref,
  });
  const currentHead = await worktreeHeadOptional(worktree);
  const headAheadOfBase = await isHeadAheadOfBase(
    worktree,
    pull.base_ref,
    currentHead,
  );
  return {
    currentHead,
    headAheadOfBase,
    steps: evaluateWorkflowSteps({
      currentHead,
      headAheadOfBase,
      latestReview: reviewObservation(
        latestWorkflowRunReview(prIssue.id, run.id),
      ),
    }),
  };
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
  const review = prIssue ? latestWorkflowRunReview(prIssue.id, run.id) : null;
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

// The base SHA pinned into a Verify launch: the merge-base of the run's base branch and the
// head under review, so the (base SHA, head SHA) pointer pair identifies the exact diff even if
// the base branch advances while Verify runs.
async function pinnedBaseSha(
  worktree: string,
  baseBranch: string,
  headSha: string,
): Promise<string> {
  const result = await git(worktree, ["merge-base", baseBranch, headSha]);
  const baseSha = result.stdout.trim();
  if (result.code !== 0 || !baseSha) {
    throw new ServiceError(
      409,
      `could not resolve merge-base of ${baseBranch} and ${headSha}: ${result.stderr.trim()}`,
    );
  }
  return baseSha;
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
  | "advance_to_verify"
  | "await_human"
  | "resume_after_human"
  | "stop"
  | "request_rework"
  | "complete";

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
      parentContract: string;
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
        parentSessionId: sessionId,
      });

      const systemPromptPath = writeParentContract(
        run.id,
        renderWorkflowContract({
          template: input.parentContract,
          step: "parent",
          worktreePath: wtPath,
          baseBranch: pull.base_ref,
        }),
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
          user_prompt: parentUserPrompt({
            runId: run.id,
            repoName: r.full_name,
            workflowName: workflow.name,
            issueNumber: issue.number,
            prNumber: opened.number,
            baseRef: pull.base_ref,
          }),
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
      { currentStep: "verify" },
      "advance_to_verify",
      sessionId,
    );
  },

  async completeRun(
    name: string,
    input: { run: number },
    sessionId?: string | null,
  ): Promise<WorkflowRunUpdateResult> {
    const { repo, run } = lifecycleRun(name, input.run, sessionId);
    assertAutomaticProgressAllowed(run);
    if (run.current_step !== "verify") {
      throw new ServiceError(
        409,
        `Workflow run cannot complete from ${run.current_step}`,
      );
    }
    const progress = await workflowRunProgress(repo, run);
    if (!progress.steps.verify.complete) {
      throw new ServiceError(
        409,
        `Workflow Verify is incomplete: ${progress.steps.verify.missing.join("; ")}`,
      );
    }
    if (progress.steps.verify.latest_review?.event !== "pass") {
      throw new ServiceError(409, "Workflow Verify review is not passing");
    }
    return updateRunLifecycle(
      run,
      { status: "completed", needsHumanReason: null },
      "complete",
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
      { currentStep: step, reworkCount: 0, needsHumanReason: null },
      "resume_after_human",
      sessionId,
    );
  },

  stopRun(
    name: string,
    input: { run: number },
    sessionId?: string | null,
  ): WorkflowRunUpdateResult {
    const { run } = lifecycleRun(name, input.run, sessionId);
    assertRunningLifecycle(run);
    return updateRunLifecycle(
      run,
      { status: "stopped", needsHumanReason: null },
      "stop",
      sessionId,
    );
  },

  async enforceCostLimit(
    name: string,
    input: { run: number; usageSession?: string },
    sessionId?: string | null,
  ): Promise<WorkflowRunCostLimitResult> {
    const { repo, run } = lifecycleRun(name, input.run, sessionId);
    const configuredLimit = devCostLimitUsd();
    const executeSessions = workflowStepSessionIds(
      run.step_sessions_json,
      "execute",
    );
    const verifySessions = workflowStepSessionIds(
      run.step_sessions_json,
      "verify",
    );
    const sessionIds = [
      ...(run.parent_session_id ? [run.parent_session_id] : []),
      ...executeSessions,
      ...verifySessions,
    ];
    const cost = S.sessionUsageCostSummaryForSessions(sessionIds);
    if (S.hasWorkflowRunCostStopEvent(repo.id, run.id)) {
      return {
        run: runJSON(run),
        action: "skipped",
        reason: "already_stopped",
        cost_usd: cost.cost_usd,
        limit_usd: configuredLimit,
        stopped_session_id: null,
        unobserved_session_ids: cost.unobserved_session_ids,
        unknown_cost_session_ids: cost.unknown_cost_session_ids,
      };
    }
    assertAutomaticProgressAllowed(run);
    const currentStep = workflowStep(run.current_step);
    const sessionSteps = new Map<string, WorkflowStep>([
      ...executeSessions.map((id) => [id, "execute"] as const),
      ...verifySessions.map((id) => [id, "verify"] as const),
    ]);
    const costUsd = cost.cost_usd;
    if (costUsd === null) {
      return {
        run: runJSON(run),
        action: "skipped",
        reason: "unknown_cost",
        cost_usd: null,
        limit_usd: configuredLimit,
        stopped_session_id: null,
        unobserved_session_ids: cost.unobserved_session_ids,
        unknown_cost_session_ids: cost.unknown_cost_session_ids,
      };
    }
    if (costUsd <= configuredLimit) {
      return {
        run: runJSON(run),
        action: "skipped",
        reason: "under_limit",
        cost_usd: costUsd,
        limit_usd: configuredLimit,
        stopped_session_id: null,
        unobserved_session_ids: cost.unobserved_session_ids,
        unknown_cost_session_ids: cost.unknown_cost_session_ids,
      };
    }
    if (
      input.usageSession &&
      input.usageSession !== run.parent_session_id &&
      !sessionSteps.has(input.usageSession)
    ) {
      throw new ServiceError(
        409,
        "usage session does not belong to Workflow run",
      );
    }
    const agentsOut = await runHerdr(
      "herdr",
      ["--session", herdrSessionName(repo), "agent", "list"],
      repo.local_path,
      { captureStdout: true, timeoutMs: 15_000 },
    );
    const placements = parseHerdrAgentPlacements(
      agentsOut,
      worktreeRoot(),
      repo.full_name,
    );
    const candidates = placements.flatMap((placement) => {
      if (placement.status !== "working" || placement.pull !== run.pr_number) {
        return [];
      }
      const agent = parseWorkflowHerdrAgentName(placement.name);
      if (agent?.kind !== "step" || agent.runId !== run.id) return [];
      const session = [...sessionSteps].find(([id, step]) => {
        return (
          step === agent.step && S.getAgentSession(id)?.name === placement.name
        );
      });
      if (!session) return [];
      return [
        {
          pane: placement,
          sessionId: session[0],
          step: session[1],
          sequence: agent.sequence,
          usageUpdatedAt: S.latestSessionUsageAt(session[0]),
        },
      ];
    });
    const requestedChild = input.usageSession
      ? sessionSteps.get(input.usageSession)
      : undefined;
    const target = requestedChild
      ? candidates.find(
          (candidate) => candidate.sessionId === input.usageSession,
        )
      : candidates
          .filter((candidate) => candidate.step === currentStep)
          .sort((a, b) => {
            const byUsage = (b.usageUpdatedAt ?? "").localeCompare(
              a.usageUpdatedAt ?? "",
            );
            return byUsage || b.sequence - a.sequence;
          })[0];
    if (!target || !HERDR_ID.test(target.pane.id)) {
      throw new ServiceError(
        409,
        "Workflow usage session has no currently running child",
      );
    }
    const updated = S.stopWorkflowRunIfRunning(run.id);
    if (!updated) {
      return {
        run: runJSON(workflowRunOr404(run.id)),
        action: "skipped",
        reason: "already_stopped",
        cost_usd: costUsd,
        limit_usd: configuredLimit,
        stopped_session_id: null,
        unobserved_session_ids: cost.unobserved_session_ids,
        unknown_cost_session_ids: cost.unknown_cost_session_ids,
      };
    }
    S.emitEvent(repo.id, "workflow_run.updated", actorFor(sessionId), {
      id: updated.id,
      transition: "stop",
      status: updated.status,
      current_step: updated.current_step,
      rework_count: updated.rework_count,
      issue_number: updated.issue_number,
      pr_number: updated.pr_number,
    });
    try {
      await runHerdr(
        "herdr",
        [
          "--session",
          herdrSessionName(repo),
          "pane",
          "send-keys",
          target.pane.id,
          "Escape",
        ],
        repo.local_path,
        { timeoutMs: 10_000 },
      );
    } catch (error) {
      S.emitEvent(
        repo.id,
        "workflow_run.cost_stop_failed",
        actorFor(sessionId),
        {
          id: run.id,
          number: run.pr_number,
          pr_number: run.pr_number,
          session_id: target.sessionId,
          step: target.step,
          cost_usd: costUsd,
          limit_usd: configuredLimit,
          reason: error instanceof Error ? error.message : "unknown error",
        },
      );
      throw error;
    }
    S.emitEvent(repo.id, "dev.cost_stopped", actorFor(sessionId), {
      number: run.pr_number,
      pr: run.pr_number,
      run_id: run.id,
      session_id: target.sessionId,
      step: target.step,
      reason: "cost_limit_exceeded",
      cost_usd: costUsd,
      limit_usd: configuredLimit,
    });
    return {
      run: runJSON(updated),
      action: "stopped",
      reason: "over_limit",
      cost_usd: costUsd,
      limit_usd: configuredLimit,
      stopped_session_id: target.sessionId,
      unobserved_session_ids: cost.unobserved_session_ids,
      unknown_cost_session_ids: cost.unknown_cost_session_ids,
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
      { currentStep: "execute", reworkCount: run.rework_count + 1 },
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
      contract: string;
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
      step,
      reviewId,
      baseSha,
      headSha,
    });
    const composed = composeWorkflowLaunchPrompt(
      {
        template: stepContractForLaunch(step, input.contract),
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
    if (step === "verify") {
      if (!input.headSha || !/^[0-9a-f]{40,64}$/u.test(input.headSha)) {
        throw new ServiceError(
          422,
          "confirmed Verify launch requires a commit SHA",
        );
      }
    }
    const handoffBody = [
      `Launch Workflow ${step} step for run #${run.id}.`,
      "",
      "## Inputs",
      ...input.pointers.map(
        (pointer) => `- ${pointer.label}: ${pointer.value}`,
      ),
      ...(input.note?.trim()
        ? ["", "## Note from parent", input.note.trim()]
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
      summary: `Launch ${step} step`,
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
    return { run: runJSON(withSession), session_id: sessionId };
  },

  // The Execute child's payload-less turn-done declaration. It is a timing signal only: the
  // engine records the fact as an event (the worker delivers it to the subscribed parent pane),
  // and the parent then observes HEAD / review state before deciding any transition. The
  // declaration never carries content and never substitutes for domain truth.
  turnDone(
    name: string,
    input: { run: number },
    sessionId?: string | null,
  ): WorkflowTurnDoneResult {
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
        // pane by this session id (same pattern as pull_request.github_feedback).
        parent_session_id: run.parent_session_id,
        session_id: sessionId ?? null,
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
      contract: string;
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
      step,
      reviewId,
      baseSha,
      headSha,
    });
    const composed = composeWorkflowLaunchPrompt(
      {
        template: stepContractForLaunch(step, input.contract),
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
    return {
      run: run.id,
      current_step: run.current_step,
      status: run.status,
      needs_human_reason: run.needs_human_reason,
      head_sha: progress.currentHead,
      head_ahead_of_base: progress.headAheadOfBase,
      last_turn_done_at: S.latestWorkflowTurnDoneAt(r.id, run.id),
      steps: progress.steps,
    };
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

  // Worker-owned stall visibility (#1358): a running, non-held run whose latest lifecycle
  // activity (run started/updated, step launched, turn-done declared) is older than the
  // threshold is surfaced to a human — except a Verify run waiting after a fresh passing review.
  // No automatic recovery is attempted; resume / stop stay explicit human actions.
  sweepStalledRuns(input: { thresholdMs: number; now?: number }): {
    held: number[];
    failed: number[];
  } {
    const held: number[] = [];
    const failed: number[] = [];
    const nowMs = input.now ?? Date.now();
    const minutes = Math.max(1, Math.round(input.thresholdMs / 60_000));
    for (const run of S.listRunningWorkflowRuns()) {
      // Isolate each run: one repo's failure (e.g. inbox.send -> ensureWritable throwing because
      // the repo was archived while the run was still running) must not abort the batch and leave
      // later stalled runs unsurfaced. The sibling GitHub feedback sweep isolates per-PR the same way.
      try {
        if (run.needs_human_reason !== null) continue;
        const repo = S.getRepoById(run.repo_id);
        if (!repo) continue;
        const lastActivity =
          S.latestWorkflowRunActivityAt(run.repo_id, run.id) ?? run.updated_at;
        const lastActivityMs = Date.parse(lastActivity);
        if (
          !Number.isFinite(lastActivityMs) ||
          nowMs - lastActivityMs < input.thresholdMs
        ) {
          continue;
        }
        if (hasFreshPassingWorkflowReview(run)) continue;
        const reason = `no turn-done declaration or run activity for ${minutes} minutes`;
        // Send the human notification first: if it throws (archived/read-only repo), the run is
        // left running and un-held, so the next tick retries cleanly instead of holding a run whose
        // human notice never went out.
        inbox.send(repo.full_name, {
          from: {
            kind: "workflow_run",
            repo: repo.full_name,
            actor: "lh-worker",
          },
          title: `Workflow run #${run.id} stalled: no turn-done declaration`,
          body: [
            `Workflow run #${run.id} (issue #${run.issue_number}, PR #${run.pr_number}) made no`,
            `progress for ${minutes} minutes: no turn-done declaration and no lifecycle activity.`,
            "",
            "The run is now held for a human (needs-human). Inspect the run and either resume it",
            `(\`lh workflow run resume --repo '${repo.full_name}' --run ${run.id} --step <execute|verify>\`)`,
            `or stop it (\`lh workflow run stop --repo '${repo.full_name}' --run ${run.id}\`).`,
          ].join("\n"),
        });
        const updated = S.updateWorkflowRun(run.id, {
          needsHumanReason: reason,
        });
        if (!updated) continue;
        S.emitEvent(run.repo_id, "workflow_run.updated", "lh-worker", {
          id: updated.id,
          transition: "await_human",
          status: updated.status,
          current_step: updated.current_step,
          rework_count: updated.rework_count,
          needs_human_reason: updated.needs_human_reason,
          issue_number: updated.issue_number,
          pr_number: updated.pr_number,
        });
        held.push(run.id);
      } catch (e) {
        failed.push(run.id);
        console.error(
          `lh-worker: workflow stall sweep failed for run #${run.id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
    return { held, failed };
  },
};
