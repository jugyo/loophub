import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { saveAttachment } from "../attachments.ts";
import {
  agentModel,
  type CodingAgent,
  configDir,
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
  WorkflowRunStateWire,
  WorkflowRunVerdictSummaryWire,
} from "../serialize.ts";
import {
  buildWorkflowStepHerdrLaunchPlan,
  herdrSessionName,
} from "../terminal/terminal-launch.ts";
import { parsePreviousWorkflowVerifyPane } from "../terminal/workflow-pane-layout.ts";
import {
  parseWorkflowArtifactJson,
  type WorkflowArtifact,
  type WorkflowArtifactType,
  type WorkflowExecutionReportArtifact,
  type WorkflowVerdictArtifact,
} from "../workflow/artifacts.ts";
import {
  composeWorkflowLaunchPrompt,
  renderWorkflowContract,
  WORKFLOW_STEPS,
  type WorkflowStep,
} from "../workflow/compose.ts";
import {
  nextWorkflowChildSequence,
  parseWorkflowHerdrAgentName,
} from "../workflow/herdr-agents.ts";
import {
  composeExecuteInputArtifacts,
  composeVerifyInputArtifacts,
  type WorkflowIssueInput,
  type WorkflowStepInputSet,
  writeWorkflowStepInputArtifacts,
} from "../workflow/inputs.ts";
import { placeWorkflowArtifact } from "../workflow/placement.ts";
import {
  evaluateWorkflowSteps,
  type WorkflowLatestArtifactState,
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
import { pulls } from "./pulls.ts";
import { reviews } from "./reviews.ts";
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
  input_files: Array<{ path: string; description: string }>;
  head_sha?: string;
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

export type WorkflowStepOutputResult = {
  artifact_id: number;
  head_sha: string;
  placement: { kind: string; ref: string };
  retried: boolean;
};

export type WorkflowStepInputResult = {
  run: WorkflowRunUpdateResult["run"];
  step: WorkflowStep;
  system_prompt: string;
  system_prompt_path: string;
  user_prompt: string;
  input_files: Array<{ path: string; description: string }>;
};

export type WorkflowStepStatusResult = {
  run: number;
  current_step: string;
  status: string;
  // Non-null while the run is held for a human (#1307) — surfaced here so the parent's re-check
  // and an operator's inspection see the hold instead of a plain running run.
  needs_human_reason: string | null;
  head_sha: string | null;
  steps: WorkflowStepStatuses;
};

const STEP_ARTIFACT_TYPE: Record<WorkflowStep, WorkflowArtifactType> = {
  execute: "execution-report",
  verify: "verdict",
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

function parentUserPrompt(input: {
  runId: number;
  repoName: string;
  workflowName: string;
  issueNumber: number;
  prNumber: number;
  inputFiles: Array<{ path: string; description: string }>;
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
    "",
    "## Inputs",
    ...input.inputFiles.map((file) => `- ${file.path} - ${file.description}`),
    `worktree: . (cwd. base branch: ${input.baseRef})`,
    "",
    "## Instruction",
    "Orchestrate this run through Execute -> Verify as described in your contract.",
    `Drive every transition from \`lh workflow step status ${input.runId} --repo ${repo} --json\`; never use pane output or PR body markers to decide a step is complete.`,
    "Start now:",
    `1. Launch the Execute child: \`lh workflow launch-step --repo ${repo} --run ${input.runId} --step execute\``,
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

function issueInput(issue: S.IssueRow): WorkflowIssueInput {
  return {
    title: issue.title,
    body: issue.body,
    comments: S.listComments(issue.id).map((comment) => ({
      author: comment.author,
      createdAt: comment.created_at,
      body: comment.body,
    })),
  };
}

async function composeLaunchInputs(input: {
  issue: S.IssueRow;
  pull: S.PullRow;
  run: S.WorkflowRunRow;
  step: WorkflowStep;
  worktree: string;
}): Promise<WorkflowStepInputSet> {
  const task = issueInput(input.issue);
  switch (input.step) {
    case "execute":
      return composeExecuteInputArtifacts({
        issue: task,
        latestVerdict: readLatestArtifactOptional(input.run, "verdict"),
        verdictHeadSha: latestArtifactHead(input.run, "verdict"),
      });
    case "verify":
      return composeVerifyInputArtifacts({
        issue: task,
        ...(await pinnedDiff(input.worktree, input.pull.base_ref)),
        report: readLatestArtifact(input.run, "execution-report"),
        priorVerdicts: compact([
          readLatestArtifactOptional(input.run, "verdict"),
        ]),
      });
  }
}

function latestArtifactHead(
  run: S.WorkflowRunRow,
  type: WorkflowArtifactType,
): string | undefined {
  return S.latestWorkflowArtifactByType(run.id, type)?.head_sha;
}

function readLatestArtifact(
  run: S.WorkflowRunRow,
  type: "execution-report",
): WorkflowExecutionReportArtifact;
function readLatestArtifact(
  run: S.WorkflowRunRow,
  type: "verdict",
): WorkflowVerdictArtifact;
function readLatestArtifact(
  run: S.WorkflowRunRow,
  type: WorkflowArtifactType,
): WorkflowArtifact {
  const row = S.latestWorkflowArtifactByType(run.id, type);
  if (!row) {
    throw new ServiceError(409, `launch-step requires latest ${type} artifact`);
  }
  const parsed = parseWorkflowArtifactJson(row.content_json);
  if (!parsed.ok) {
    throw new ServiceError(
      422,
      `invalid ${type} artifact: ${parsed.violations.map((v) => `${v.path} ${v.message}`).join("; ")}`,
    );
  }
  if (parsed.artifact.type !== type) {
    throw new ServiceError(
      422,
      `expected ${type} artifact, got ${parsed.artifact.type}`,
    );
  }
  return parsed.artifact;
}

function readLatestArtifactOptional(
  run: S.WorkflowRunRow,
  type: "verdict",
): WorkflowVerdictArtifact | undefined {
  return S.latestWorkflowArtifactByType(run.id, type)
    ? readLatestArtifact(run, type)
    : undefined;
}

function compact<T>(values: Array<T | undefined>): T[] {
  return values.filter((value): value is T => value !== undefined);
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

function latestArtifactState(
  run: S.WorkflowRunRow,
  type: WorkflowArtifactType,
): WorkflowLatestArtifactState | null {
  const row = S.latestWorkflowArtifactByType(run.id, type);
  if (!row) return null;
  return {
    headSha: row.head_sha,
    placed: Boolean(S.getWorkflowPlacement(row.id)),
  };
}

function latestVerdictContent(
  run: S.WorkflowRunRow,
): WorkflowVerdictArtifact | null {
  const row = S.latestWorkflowArtifactByType(run.id, "verdict");
  if (!row) return null;
  const parsed = parseWorkflowArtifactJson(row.content_json);
  if (!parsed.ok || parsed.artifact.type !== "verdict") return null;
  return parsed.artifact;
}

async function workflowRunProgress(
  repo: S.Repo,
  run: S.WorkflowRunRow,
): Promise<{
  currentHead: string | null;
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
    steps: evaluateWorkflowSteps({
      currentHead,
      headAheadOfBase,
      execute: latestArtifactState(run, "execution-report"),
      verify: latestArtifactState(run, "verdict"),
      latestVerdict: latestVerdictContent(run),
    }),
  };
}

// Build the issue / PR detail display state (#1008) from a run row. The row is the display-state
// source (workflow design: CLI / UI); this does not re-derive step-completion truth (that is
// `workflow step status`).
// `latest_verdict` gives the human-readable reason behind a rework / block.
function workflowRunState(run: S.WorkflowRunRow): WorkflowRunStateWire {
  const workflowName = run.workflow_id
    ? (S.getWorkflowById(run.workflow_id)?.name ?? null)
    : null;
  const verdict = latestVerdictContent(run);
  const latestVerdict: WorkflowRunVerdictSummaryWire | null = verdict
    ? {
        event: verdict.event,
        summary: verdict.summary,
        findings_count: verdict.findings.length,
      }
    : null;
  return workflowRunStateJSON({ run, workflowName, latestVerdict });
}

function safeEvidenceAttachment(
  worktree: string,
  path: string,
  author: string,
): string {
  const candidate = join(worktree, path);
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new ServiceError(
      422,
      `Workflow evidence path must not be a symlink: ${path}`,
    );
  }
  const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new ServiceError(
        422,
        `Workflow evidence path must be a regular file: ${path}`,
      );
    }
    const resolved = realpathSync(candidate);
    const checked = statSync(resolved);
    if (checked.dev !== opened.dev || checked.ino !== opened.ino) {
      throw new ServiceError(
        422,
        `Workflow evidence path changed while opening: ${path}`,
      );
    }
    const rel = relative(realpathSync(worktree), resolved);
    if (rel.startsWith("..") || rel.startsWith(sep)) {
      throw new ServiceError(
        422,
        `Workflow evidence path escapes worktree: ${path}`,
      );
    }
    return saveAttachment({
      data: readFileSync(fd),
      filename: basename(resolved),
      author,
    }).markdown;
  } finally {
    closeSync(fd);
  }
}

async function placeAcceptedArtifact(input: {
  repoName: string;
  run: S.WorkflowRunRow;
  artifactId: number;
  ownerToken: string;
  ownershipLost: () => boolean;
  artifact: WorkflowArtifact;
  headSha: string;
  worktree: string;
  sessionId?: string | null;
}): Promise<{ kind: string; ref: string }> {
  const current = await pulls.get(input.repoName, input.run.pr_number);
  return placeWorkflowArtifact({
    artifact: input.artifact,
    headSha: input.headSha,
    issueNumber: input.run.issue_number,
    dependencies: {
      currentDraft: current.draft,
      assertOwnership() {
        if (
          input.ownershipLost() ||
          !S.ownsWorkflowPlacementClaim(input.artifactId, input.ownerToken)
        ) {
          throw new ServiceError(
            409,
            "Workflow artifact placement claim was lost",
          );
        }
      },
      async updateBody(body) {
        await pulls.update(
          input.repoName,
          input.run.pr_number,
          { body },
          input.sessionId,
        );
      },
      async readyForReview() {
        await pulls.readyForReview(
          input.repoName,
          input.run.pr_number,
          undefined,
          input.sessionId,
          () => {
            if (
              input.ownershipLost() ||
              !S.ownsWorkflowPlacementClaim(input.artifactId, input.ownerToken)
            ) {
              throw new ServiceError(
                409,
                "Workflow artifact placement claim was lost",
              );
            }
          },
        );
      },
      async createReview(review) {
        return String(
          (
            await reviews.create(
              input.repoName,
              input.run.pr_number,
              { ...review, topic: "workflow" },
              input.sessionId,
            )
          ).id,
        );
      },
      attach(path) {
        return safeEvidenceAttachment(
          input.worktree,
          path,
          actorFor(input.sessionId),
        );
      },
      record(kind, ref) {
        S.createWorkflowPlacement(input.artifactId, kind, ref);
      },
    },
  });
}

async function pinnedDiff(
  worktree: string,
  baseBranch: string,
): Promise<{ headSha: string; baseBranch: string; diff: string }> {
  const head = await git(worktree, ["rev-parse", "HEAD"]);
  const headSha = head.stdout.trim();
  if (head.code !== 0 || !headSha) {
    throw new ServiceError(409, "could not resolve Workflow worktree HEAD");
  }
  const diff = await git(worktree, ["diff", `${baseBranch}...${headSha}`]);
  if (diff.code !== 0) {
    throw new ServiceError(
      409,
      `could not compose verify diff from ${baseBranch}...${headSha}: ${diff.stderr.trim()}`,
    );
  }
  return { headSha, baseBranch, diff: diff.stdout };
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

      const inputFiles = writeWorkflowStepInputArtifacts(
        ensureWorkflowRunDir(run.id),
        composeExecuteInputArtifacts({ issue: issueInput(issue) }),
      );
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
            inputFiles,
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
    if (progress.steps.verify.latest_verdict?.event !== "pass") {
      throw new ServiceError(409, "Workflow Verify verdict is not passing");
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
    const reason = inlineText(input.reason);
    if (!reason) {
      throw new ServiceError(422, "await-human requires a reason");
    }
    if (reason.length > 500) {
      throw new ServiceError(
        422,
        "await-human reason must be at most 500 characters",
      );
    }
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
      const progress = await workflowRunProgress(repo, run);
      if (!progress.steps.execute.complete) {
        throw new ServiceError(
          409,
          `Workflow cannot resume at Verify: ${progress.steps.execute.missing.join("; ")}`,
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
    if (progress.steps.verify.latest_verdict?.event !== "request_changes") {
      throw new ServiceError(
        409,
        "Workflow Verify verdict does not request changes",
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
    const issue = issueOr404(r, run.issue_number, "issue");
    const prIssue = issueOr404(r, run.pr_number, "pull");
    const pull = S.getPull(prIssue.id);
    if (!pull)
      throw new ServiceError(404, `pull request #${run.pr_number} not found`);
    const worktree = workflowRunWorktree({
      repo: r,
      prNumber: run.pr_number,
      headRef: pull.head_ref,
    });
    const inputFiles = writeWorkflowStepInputArtifacts(
      ensureWorkflowRunDir(run.id),
      await composeLaunchInputs({
        issue,
        pull,
        run,
        step,
        worktree,
      }),
    );
    const headSha =
      step === "verify" ? await worktreeHead(worktree) : undefined;
    const composed = composeWorkflowLaunchPrompt(
      {
        template: stepContractForLaunch(step, input.contract),
        step,
        worktreePath: worktree,
        baseBranch: pull.base_ref,
      },
      {
        inputFiles,
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
      input_files: inputFiles,
      head_sha: headSha,
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
      inputFiles: Array<{ path: string; description: string }>;
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
      S.setWorkflowStepPin(run.id, step, sessionId, input.headSha);
      if (S.getWorkflowStepPin(run.id, step, sessionId) !== input.headSha) {
        throw new ServiceError(422, "Verify session pin cannot be changed");
      }
    }
    const handoffBody = [
      `Launch Workflow ${step} step for run #${run.id}.`,
      "",
      "## Inputs",
      ...input.inputFiles.map((file) => `- ${file.path} - ${file.description}`),
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
        // Both issue / PR numbers so issue & PR detail refresh their run-state query precisely (#1008).
        issue_number: run.issue_number,
        pr_number: run.pr_number,
      },
    );
    return { run: runJSON(withSession), session_id: sessionId };
  },

  async stepOutput(
    name: string,
    input: { run: number; step: string; content: string },
    sessionId?: string | null,
  ): Promise<WorkflowStepOutputResult> {
    const r = repoOr404(name);
    ensureWritable(r);
    const run = workflowRunOr404(input.run);
    if (run.repo_id !== r.id)
      throw new ServiceError(404, "Workflow run not found for repo");
    if (run.status !== "running")
      throw new ServiceError(422, `Workflow run is ${run.status}`);
    const step = workflowStep(input.step);
    if (!stepActorAllowed(run, step, sessionId)) {
      throw new ServiceError(
        403,
        "Workflow step output must be submitted by the parent or launched step session",
      );
    }
    const parsed = parseWorkflowArtifactJson(input.content);
    if (!parsed.ok) {
      throw new ServiceError(
        422,
        `invalid artifact: ${parsed.violations.map((v) => `${v.path} ${v.message}`).join("; ")}`,
      );
    }
    const expected = STEP_ARTIFACT_TYPE[step];
    if (parsed.artifact.type !== expected) {
      throw new ServiceError(
        422,
        `expected ${expected} artifact for ${step}, got ${parsed.artifact.type}`,
      );
    }
    const prIssue = issueOr404(r, run.pr_number, "pull");
    const pull = S.getPull(prIssue.id);
    if (!pull)
      throw new ServiceError(404, `pull request #${run.pr_number} not found`);
    const worktree = workflowRunWorktree({
      repo: r,
      prNumber: run.pr_number,
      headRef: pull.head_ref,
    });
    const currentHead = await worktreeHead(worktree);
    let headSha = currentHead;
    if (
      parsed.artifact.type === "verdict" &&
      sessionId !== run.parent_session_id
    ) {
      const actor = sessionId ? S.getAgentSession(sessionId) : null;
      if (actor?.agent !== "me") {
        const pin = sessionId
          ? S.getWorkflowStepPin(run.id, step, sessionId)
          : null;
        if (!pin || !/^[0-9a-f]{40,64}$/u.test(pin)) {
          throw new ServiceError(
            422,
            "Verify session has no confirmed launch pin",
          );
        }
        const resolved = await git(worktree, [
          "cat-file",
          "-e",
          `${pin}^{commit}`,
        ]);
        if (resolved.code !== 0) {
          throw new ServiceError(
            422,
            "Verify launch pin is not a worktree commit",
          );
        }
        headSha = pin;
      }
    }
    const contentJson = JSON.stringify(parsed.artifact);
    const latest = S.latestWorkflowArtifact(run.id, step);
    const latestPlacement = latest ? S.getWorkflowPlacement(latest.id) : null;
    const retryUnplaced =
      latest &&
      !latestPlacement &&
      latest.content_json === contentJson &&
      S.getWorkflowArtifactSubmitter(latest.id) === sessionId;
    const artifact = retryUnplaced
      ? latest
      : S.createWorkflowArtifact({
          runId: run.id,
          step,
          type: parsed.artifact.type,
          contentJson,
          headSha,
          submittedBy: sessionId!,
          dedupeKey: createHash("sha256")
            .update(
              `${run.id}\0${step}\0${sessionId}\0${contentJson}\0${headSha}`,
            )
            .digest("hex"),
        });
    headSha = artifact.head_sha;
    const existing = S.getWorkflowPlacement(artifact.id);
    if (existing) {
      return {
        artifact_id: artifact.id,
        head_sha: headSha,
        placement: { kind: existing.target_kind, ref: existing.target_ref },
        retried: true,
      };
    }
    let claimToken = S.claimWorkflowPlacement(artifact.id);
    for (let attempt = 0; !claimToken && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const completed = S.getWorkflowPlacement(artifact.id);
      if (completed) {
        return {
          artifact_id: artifact.id,
          head_sha: headSha,
          placement: {
            kind: completed.target_kind,
            ref: completed.target_ref,
          },
          retried: true,
        };
      }
      claimToken = S.claimWorkflowPlacement(artifact.id);
    }
    if (!claimToken) {
      throw new ServiceError(
        409,
        "Workflow artifact placement is already in progress",
      );
    }
    const completedAfterClaim = S.getWorkflowPlacement(artifact.id);
    if (completedAfterClaim) {
      S.releaseWorkflowPlacementClaim(artifact.id, claimToken);
      return {
        artifact_id: artifact.id,
        head_sha: headSha,
        placement: {
          kind: completedAfterClaim.target_kind,
          ref: completedAfterClaim.target_ref,
        },
        retried: true,
      };
    }
    let placed: { kind: string; ref: string };
    let claimLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!S.renewWorkflowPlacementClaim(artifact.id, claimToken)) {
          claimLost = true;
        }
      } catch {
        claimLost = true;
      }
    }, 30_000);
    heartbeat.unref();
    try {
      placed = await placeAcceptedArtifact({
        repoName: r.full_name,
        run,
        artifactId: artifact.id,
        ownerToken: claimToken,
        ownershipLost: () => claimLost,
        artifact: parsed.artifact,
        headSha,
        worktree,
        sessionId,
      });
      S.clearWorkflowArtifactDedupe(artifact.id);
    } finally {
      clearInterval(heartbeat);
      S.releaseWorkflowPlacementClaim(artifact.id, claimToken);
    }
    S.emitEvent(r.id, "workflow_artifact.placed", actorFor(sessionId), {
      id: run.id,
      artifact_id: artifact.id,
      step,
      type: parsed.artifact.type,
      head_sha: headSha,
      target_kind: placed.kind,
      target_ref: placed.ref,
      // Both issue / PR numbers so issue & PR detail refresh their run-state query precisely (#1008).
      issue_number: run.issue_number,
      pr_number: run.pr_number,
    });
    return {
      artifact_id: artifact.id,
      head_sha: headSha,
      placement: placed,
      retried: Boolean(retryUnplaced),
    };
  },

  async stepInput(
    name: string,
    input: { run: number; step: string; note?: string; contract: string },
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
    const issue = issueOr404(r, run.issue_number, "issue");
    const prIssue = issueOr404(r, run.pr_number, "pull");
    const pull = S.getPull(prIssue.id);
    if (!pull)
      throw new ServiceError(404, `pull request #${run.pr_number} not found`);
    const worktree = workflowRunWorktree({
      repo: r,
      prNumber: run.pr_number,
      headRef: pull.head_ref,
    });
    const inputFiles = writeWorkflowStepInputArtifacts(
      ensureWorkflowRunDir(run.id),
      await composeLaunchInputs({
        issue,
        pull,
        run,
        step,
        worktree,
      }),
    );
    const composed = composeWorkflowLaunchPrompt(
      {
        template: stepContractForLaunch(step, input.contract),
        step,
        worktreePath: worktree,
        baseBranch: pull.base_ref,
      },
      {
        inputFiles,
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
      input_files: inputFiles,
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
      steps: progress.steps,
    };
  },

  // Display state for issue / PR detail (#1008): the latest run linked to the issue / PR, or null
  // when none. Reads only the run row (+ workflow name + latest verdict) — no git — so it stays a
  // cheap display query and does not recompute completion truth.
  stateForIssue(
    name: string,
    input: { issue: number },
    _sessionId?: string | null,
  ): WorkflowRunStateWire | null {
    const r = repoOr404(name);
    const run = S.latestWorkflowRunForIssue(r.id, input.issue);
    return run ? workflowRunState(run) : null;
  },

  stateForPull(
    name: string,
    input: { pull: number },
    _sessionId?: string | null,
  ): WorkflowRunStateWire | null {
    const r = repoOr404(name);
    const run = S.latestWorkflowRunForPull(r.id, input.pull);
    return run ? workflowRunState(run) : null;
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
    return S.eventsForWorkflowRun(r.id, run.id).map(
      workflowRunHistoryEventJSON,
    );
  },
};
