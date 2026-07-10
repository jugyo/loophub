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
import { configDir, worktreeRoot } from "../config.ts";
import {
  acquireDevLock,
  devLockPath,
  pidAlive,
  removeDevLock,
} from "../dev-lock.ts";
import { git } from "../git.ts";
import { RUNTIME_CLAUDE_CODE, resolveWorktreeIdentity } from "../resume.ts";
import type {
  WorkflowRunStateWire,
  WorkflowRunVerdictSummaryWire,
} from "../serialize.ts";
import { buildWorkflowStepHerdrLaunchPlan } from "../terminal/terminal-launch.ts";
import {
  parseWorkflowArtifactJson,
  type WorkflowArtifact,
  type WorkflowArtifactType,
  type WorkflowExecutionReportArtifact,
  type WorkflowPlanArtifact,
  type WorkflowVerdictArtifact,
} from "../workflow/artifacts.ts";
import {
  composeWorkflowLaunchPrompt,
  renderWorkflowContract,
  WORKFLOW_STEPS,
  type WorkflowStep,
} from "../workflow/compose.ts";
import {
  composeExecuteInputArtifacts,
  composePlanInputArtifacts,
  composeReflectInputArtifacts,
  composeVerifyInputArtifacts,
  type WorkflowIssueInput,
  type WorkflowStepInputSet,
  type WorkflowTimelineEntryInput,
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
import { provisionWorktree } from "../worktree-provision.ts";
import { comments } from "./comments.ts";
import { dev } from "./dev.ts";
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
    parent_session_id: string | null;
    step_sessions_json: string;
  };
};

export type WorkflowLaunchStepResult = {
  run: WorkflowRunUpdateResult["run"];
  step: WorkflowStep;
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
  head_sha: string | null;
  steps: WorkflowStepStatuses;
};

const STEP_ARTIFACT_TYPE: Record<WorkflowStep, WorkflowArtifactType> = {
  plan: "plan",
  execute: "execution-report",
  verify: "verdict",
  reflect: "reflection",
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
    "current step: plan",
    "",
    "## Inputs",
    ...input.inputFiles.map((file) => `- ${file.path} - ${file.description}`),
    `worktree: . (cwd. base branch: ${input.baseRef})`,
    "",
    "## Instruction",
    "Orchestrate this run through Plan -> Execute -> Verify -> Reflect as described in your contract.",
    `Drive every transition from \`lh workflow step status ${input.runId} --repo ${repo} --json\`; never use pane output or PR body markers to decide a step is complete.`,
    "Start now:",
    `1. Mark Plan running: \`lh workflow run update --repo ${repo} --run ${input.runId} --step plan --status running\``,
    `2. Launch the Plan child: \`lh workflow launch-step --repo ${repo} --run ${input.runId} --step plan\``,
    "Then follow your contract's transition table, rework, and escalation for the remaining steps. Do not invoke slash-style commands.",
    "",
  ].join("\n");
}

function stepContractForLaunch(_step: WorkflowStep, template: string): string {
  return template;
}

function runJSON(run: S.WorkflowRunRow): WorkflowRunUpdateResult["run"] {
  return {
    id: run.id,
    workflow_id: run.workflow_id,
    status: run.status,
    current_step: run.current_step,
    rework_count: run.rework_count,
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
  repo: S.Repo;
  issue: S.IssueRow;
  pullIssue: S.IssueRow;
  pull: S.PullRow;
  run: S.WorkflowRunRow;
  step: WorkflowStep;
  worktree: string;
}): Promise<WorkflowStepInputSet> {
  const task = issueInput(input.issue);
  switch (input.step) {
    case "plan":
      return composePlanInputArtifacts({ issue: task });
    case "execute":
      return composeExecuteInputArtifacts({
        issue: task,
        plan: readLatestArtifact(input.run, "plan"),
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
    case "reflect":
      return composeReflectInputArtifacts({
        issue: task,
        artifacts: [
          readLatestArtifact(input.run, "plan"),
          readLatestArtifact(input.run, "execution-report"),
          readLatestArtifact(input.run, "verdict"),
        ],
        reworkCount: input.run.rework_count,
        timeline: runTimeline(input.repo.id, input.run),
        handoffs: S.listHandoffs(input.repo.id, {
          prId: input.pullIssue.id,
        })
          .map((handoff) => handoff.body)
          .filter((body): body is string => body !== null),
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
  type: "plan",
): WorkflowPlanArtifact;
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

// Build the issue / PR detail display state (#1008) from a run row. The row is the display-state
// source (§5.2); this does not re-derive step-completion truth (that is `workflow step status`).
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
      currentBody: current.body,
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
          reviews.create(
            input.repoName,
            input.run.pr_number,
            { ...review, topic: "workflow" },
            input.sessionId,
          ).id,
        );
      },
      async createComment(body) {
        return String(
          comments.createForPull(
            input.repoName,
            input.run.pr_number,
            body,
            input.sessionId,
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

function runTimeline(
  repoId: number,
  run: S.WorkflowRunRow,
): WorkflowTimelineEntryInput[] {
  return S.listEvents(0, repoId, 1000, undefined, "asc")
    .map((event) => {
      try {
        const payload = JSON.parse(event.payload);
        if (payload?.id !== run.id && payload?.pr_number !== run.pr_number) {
          return null;
        }
        const rawStep = payload.step ?? payload.current_step;
        return {
          at: event.created_at,
          step: WORKFLOW_STEPS.includes(rawStep as WorkflowStep)
            ? (rawStep as WorkflowStep)
            : "parent",
          text: `${event.type} by ${event.actor}`,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is WorkflowTimelineEntryInput => entry !== null);
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

export const workflowRuns = {
  async start(
    name: string,
    input: {
      issue: number;
      workflow?: string;
      workflowId?: number;
      parentContract: string;
      lockPid?: number;
    },
    sessionId: string = randomUUID(),
  ): Promise<WorkflowRunStartResult> {
    const r = repoOr404(name);
    ensureWritable(r);
    const workflow = workflowByInput(input);
    const issue = issueOr404(r, input.issue, "issue");

    S.registerAgentSession(
      sessionId,
      "lh-workflow",
      sessionId,
      `Workflow #${issue.number} ${issue.title}`,
      RUNTIME_CLAUDE_CODE,
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
        allowCreatingConventionBranch: opened.created,
      });

      dev.attachSession(r.full_name, opened.number, sessionId);

      const run = S.createWorkflowRun({
        workflowId: workflow.id,
        repoId: r.id,
        issueNumber: issue.number,
        prNumber: opened.number,
        status: "running",
        currentStep: "plan",
        parentSessionId: sessionId,
      });

      const inputFiles = writeWorkflowStepInputArtifacts(
        ensureWorkflowRunDir(run.id),
        composePlanInputArtifacts({
          issue: { title: issue.title, body: issue.body },
        }),
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

  update(
    name: string,
    input: {
      run: number;
      step?: string;
      status?: string;
      reworkCount?: number;
    },
    sessionId?: string | null,
  ): WorkflowRunUpdateResult {
    const r = repoOr404(name);
    ensureWritable(r);
    const current = workflowRunOr404(input.run);
    if (current.repo_id !== r.id) {
      throw new ServiceError(404, "Workflow run not found for repo");
    }
    assertParentActor(current, sessionId);
    const patch: {
      status?: string;
      currentStep?: string;
      reworkCount?: number;
    } = {};
    if (input.step !== undefined) patch.currentStep = workflowStep(input.step);
    if (input.status !== undefined) {
      if (
        !["running", "blocked", "completed", "stopped"].includes(input.status)
      ) {
        throw new ServiceError(
          422,
          "status must be one of: running, blocked, completed, stopped",
        );
      }
      patch.status = input.status;
    }
    if (input.reworkCount !== undefined) {
      if (!Number.isInteger(input.reworkCount) || input.reworkCount < 0) {
        throw new ServiceError(
          422,
          "rework-count must be a non-negative integer",
        );
      }
      patch.reworkCount = input.reworkCount;
    }
    const updated = S.updateWorkflowRun(current.id, patch);
    if (!updated) throw new ServiceError(404, "Workflow run not found");
    S.emitEvent(updated.repo_id, "workflow_run.updated", actorFor(sessionId), {
      id: updated.id,
      status: updated.status,
      current_step: updated.current_step,
      rework_count: updated.rework_count,
      // issue / PR numbers let issue & PR detail refresh their run-state query precisely (#1008).
      issue_number: updated.issue_number,
      pr_number: updated.pr_number,
    });
    return { run: runJSON(updated) };
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
    if (run.status !== "running") {
      throw new ServiceError(409, `Workflow run is ${run.status}`);
    }
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
        repo: r,
        issue,
        pullIssue: prIssue,
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

    const herdr = buildWorkflowStepHerdrLaunchPlan({
      repo: { full_name: r.full_name, local_path: r.local_path },
      runId: run.id,
      step,
      sessionId: childSessionId,
      worktree,
      systemPromptPath,
      userPrompt: composed.userPrompt,
      tabId: input.tabId,
      model: input.model,
      permissionMode: input.auto ? "auto" : undefined,
    });

    return {
      run: runJSON(run),
      step,
      session_id: childSessionId,
      worktree,
      system_prompt_path: systemPromptPath,
      user_prompt: composed.userPrompt,
      input_files: inputFiles,
      head_sha: headSha,
      herdr,
    };
  },

  confirmStepLaunch(
    name: string,
    input: {
      run: number;
      step: string;
      sessionId: string;
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
    S.registerAgentSession(
      sessionId,
      "workflow-step",
      sessionId,
      `Workflow ${step} run #${run.id}`,
      RUNTIME_CLAUDE_CODE,
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
        repo: r,
        issue,
        pullIssue: prIssue,
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
    const prIssue = issueOr404(r, run.pr_number, "pull");
    const pull = S.getPull(prIssue.id);
    if (!pull)
      throw new ServiceError(404, `pull request #${run.pr_number} not found`);
    const worktree = workflowRunWorktree({
      repo: r,
      prNumber: run.pr_number,
      headRef: pull.head_ref,
    });
    const currentHead = await worktreeHeadOptional(worktree);
    const headAheadOfBase = await isHeadAheadOfBase(
      worktree,
      pull.base_ref,
      currentHead,
    );
    const steps = evaluateWorkflowSteps({
      currentHead,
      headAheadOfBase,
      plan: latestArtifactState(run, "plan"),
      execute: latestArtifactState(run, "execution-report"),
      verify: latestArtifactState(run, "verdict"),
      reflect: latestArtifactState(run, "reflection"),
      latestVerdict: latestVerdictContent(run),
    });
    return {
      run: run.id,
      current_step: run.current_step,
      status: run.status,
      head_sha: currentHead,
      steps,
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
};
