import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { configDir, worktreeRoot } from "../config.ts";
import {
  acquireDevLock,
  devLockPath,
  pidAlive,
  removeDevLock,
} from "../dev-lock.ts";
import { renderPevrContract } from "../pevr/compose.ts";
import {
  composePlanInputArtifacts,
  writePevrStepInputArtifacts,
} from "../pevr/inputs.ts";
import { RUNTIME_CLAUDE_CODE, resolveWorktreeIdentity } from "../resume.ts";
import {
  legacyWorktreePath,
  worktreePath as prWorktreePath,
} from "../worktree-path.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import { dev } from "./dev.ts";
import {
  actorFor,
  assertExistingLocalBranch,
  ensureWritable,
  issueOr404,
  repoOr404,
  S,
  ServiceError,
} from "./shared.ts";

export type PevrRunStartResult = {
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

function workflowByInput(input: { workflow?: string; workflowId?: number }) {
  if (input.workflow && input.workflowId !== undefined) {
    throw new ServiceError(
      422,
      "pass either --workflow or --workflow-id, not both",
    );
  }
  if (input.workflowId !== undefined) {
    const workflow = S.getPevrWorkflowById(input.workflowId);
    if (!workflow) throw new ServiceError(404, "Workflow not found");
    return workflow;
  }
  if (input.workflow) {
    const workflow = S.getPevrWorkflowByName(input.workflow.trim());
    if (!workflow) throw new ServiceError(404, "Workflow not found");
    return workflow;
  }
  throw new ServiceError(422, "--workflow or --workflow-id is required");
}

function runDir(runId: number): string {
  return join(configDir(), "runs", "pevr", String(runId));
}

function writeParentContract(runId: number, text: string): string {
  const dir = ensurePevrRunDir(runId);
  const path = join(dir, "parent-contract.md");
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

function ensurePevrRunDir(runId: number): string {
  const dir = runDir(runId);
  for (const path of [
    join(configDir(), "runs"),
    join(configDir(), "runs", "pevr"),
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
    throw new ServiceError(422, `PEVR run path must not be a symlink: ${path}`);
  }
}

function parentUserPrompt(input: {
  runId: number;
  workflowName: string;
  inputFiles: Array<{ path: string; description: string }>;
  baseRef: string;
}): string {
  return [
    "## Run context",
    `run: ${input.runId}`,
    `workflow: ${input.workflowName}`,
    "current step: plan",
    "",
    "## Inputs",
    ...input.inputFiles.map((file) => `- ${file.path} - ${file.description}`),
    `worktree: . (cwd. base branch: ${input.baseRef})`,
    "",
    "## Instruction",
    "This v1 start flow only prepares the run and launches the parent agent. Child step launch is out of scope for this run-start milestone, so verify the run context, report that the Plan step is ready to be launched by a future workflow command, and stop. Do not invoke slash-style commands.",
    "",
  ].join("\n");
}

function parentContractForStart(template: string): string {
  return [
    template,
    "",
    "## V1 run-start boundary",
    "This LoopHub build implements workflow run start and parent-agent launch only.",
    "Child step launch, artifact output, placement, and completion queries are out of scope for this milestone.",
    "For this milestone, do not call workflow step-launch or run-update commands. Report the prepared run context and stop.",
  ].join("\n");
}

export const pevrRuns = {
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
  ): Promise<PevrRunStartResult> {
    const r = repoOr404(name);
    ensureWritable(r);
    const workflow = workflowByInput(input);
    const issue = issueOr404(r, input.issue, "issue");

    S.registerAgentSession(
      sessionId,
      "lh-workflow",
      sessionId,
      `PEVR #${issue.number} ${issue.title}`,
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

      const run = S.createPevrRun({
        workflowId: workflow.id,
        repoId: r.id,
        issueNumber: issue.number,
        prNumber: opened.number,
        status: "running",
        currentStep: "plan",
        parentSessionId: sessionId,
      });

      const inputFiles = writePevrStepInputArtifacts(
        ensurePevrRunDir(run.id),
        composePlanInputArtifacts({
          issue: { title: issue.title, body: issue.body },
        }),
      );
      const systemPromptPath = writeParentContract(
        run.id,
        renderPevrContract({
          template: parentContractForStart(input.parentContract),
          step: "parent",
          worktreePath: wtPath,
          baseBranch: pull.base_ref,
        }),
      );

      S.emitEvent(r.id, "pevr_run.started", actorFor(sessionId), {
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
            workflowName: workflow.name,
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
};
