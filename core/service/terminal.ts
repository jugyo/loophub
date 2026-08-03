import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type CodingAgent, configDir, worktreeRoot } from "../config.ts";
import { db } from "../db.ts";
import { isServiceError, ServiceError } from "../errors.ts";
import type {
  HerdrRepoSessionsWire,
  HerdrSessionsWire,
  TerminalLaunchResultWire,
} from "../serialize.ts";
import { ENV_ISSUE_CREATE_HERDR_LAUNCH } from "../session-runtime.ts";
import * as S from "../store.ts";
import {
  cleanupClosedIssuePanesImpl,
  cleanupClosedPullDevAgentsImpl,
  closeManagedHerdrPaneIfUnclaimed,
  type HerdrSnapshotSweepResult,
  killPaneForegroundProcess,
  snapshotHerdrSessionsImpl,
} from "../terminal/herdr-cleanup.ts";
import {
  herdrPullWorkspacesFromAgentList,
  NO_PANE_ID_PREFIX,
  parseHerdrAgentRead,
  parseHerdrPaneLayout,
  parseHerdrSessionListIfValid,
  parseHerdrWorkspaceListIfValid,
} from "../terminal/herdr-status.ts";
import {
  acquireHerdrWorktreeWorkspace as acquireHerdrWorktreeWorkspaceCore,
  agentProgramForHerdrLaunch,
  buildHerdrLaunchPlan,
  commandForHerdrLaunch,
  displayArg,
  executeHerdrLaunchPlan,
  HERDR_ID,
  type HerdrCmdRunner,
  type HerdrLaunchOutcome,
  type HerdrLaunchRunner,
  herdrAgentFocusArgv,
  herdrCommandLine,
  herdrPaneCloseArgv,
  herdrSessionName,
  herdrTabCloseArgv,
  herdrTabFocusArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceCreateArgv,
  herdrWorkspaceFocusArgv,
  herdrWorkspaceListArgv,
  parseHerdrTabId,
  parseHerdrWorkspaceId,
  type TerminalLaunchRepo,
} from "../terminal/terminal-launch.ts";
import { workerCompatibility } from "../worker-protocol.ts";
import {
  legacyWorktreePath,
  resolveWorktreeIdentity,
  worktreePath,
} from "../worktree-path.ts";
import { isHerdrPromptError, sendHerdrPrompt } from "./herdr-prompt.ts";
import {
  isHerdrExitError,
  runHerdr,
  runHerdrCapture,
  runHerdrLaunch,
  startHerdrSession,
} from "./herdr-runner.ts";
import { issueOr404, repoOr404 } from "./shared.ts";

export interface TerminalLaunchInput {
  // Optional: the global "workflow-create" (New workflow) launch has no repo (#1889). Every other
  // workflow requires it — `launch` enforces that below before touching the repo.
  repo?: string;
  label?: string;
  workflow?:
    | "issue-create"
    | "workflow-create"
    | "github-pr-export"
    | "workflow-run";
  issueNumber?: number;
  prNumber?: number;
  // Saved workflow id for the "workflow-run" launch (#1007). Set by the issue-detail Start
  // workflow dropdown; maps to `lh workflow start ... --workflow-id <id>`.
  workflowId?: number;
  targetBranch?: string;
  prompt?: string;
  // One-shot agent/model/effort overrides from the issue-create (New issue) dropdown
  // (#1275/#1534). Plain buttons leave these unset so `lh issue new` resolves the repo's
  // effective Coding agent config. They map to the corresponding CLI flags and never touch
  // persisted Settings defaults.
  agent?: CodingAgent;
  model?: string;
  effort?: string;
}

// Spawns a launcher CLI (`lh workflow start ... --herdr`) that owns its own herdr pane. This is not
// routed through runHerdr: that helper's error messages are hardcoded around the `herdr` binary
// ("herdr command not found on PATH", "Herdr exited with status N", …), which would misreport a
// failure of `lh` itself (a missing PATH entry, an issue lookup failure, a worktree provisioning
// error, …) as a Herdr problem. The launcher owns worktree/PR provisioning and the actual herdr
// pane launch end-to-end (cli/index.ts), so this call only needs to await it and translate a
// non-zero exit.
//
// Generous relative to the individual 10s herdr-call timeouts elsewhere in this file: this one
// bounds the *whole* launcher run — issue lookup, PR open, worktree provisioning (a first-time
// `git worktree add` on a large repo), and the herdr launch itself — none of which carried an
// overall deadline before this call replaced the in-process equivalent (#584 review).
const LH_DEV_HERDR_TIMEOUT_MS = 90_000;
// Bounded tail of the child's stderr, logged server-side only (never in the thrown ServiceError)
// so an operator can see the launcher's actual failure reason (`fail(message)` etc.) without every
// failure collapsing to a bare "exited with status N" — but never reaching the HTTP client, same
// "deliberately generic" policy runHerdr documents above: raw process output can embed the
// server's absolute paths, a Node stack trace, or other detail that must not reach a non-loopback
// client (#584 review).
const LH_DEV_STDERR_TAIL_BYTES = 4 * 1024;
const NEW_ISSUE_WORKSPACE_LABEL = "New Issue";
// A repo-scoped queue closes the workspace-list/create race between simultaneous New Issue RPCs.
// It covers placement only; agent start remains outside the queue, and different repo sessions use
// different keys so their placement calls can also run in parallel.
const newIssueLaunchQueueTails = new Map<string, Promise<void>>();

async function acquireNewIssueLaunchLock(
  sessionName: string,
): Promise<() => void> {
  const previous =
    newIssueLaunchQueueTails.get(sessionName) ?? Promise.resolve();
  let releaseGate = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.then(() => gate);
  newIssueLaunchQueueTails.set(sessionName, tail);
  await previous;
  return () => {
    releaseGate();
    if (newIssueLaunchQueueTails.get(sessionName) === tail)
      newIssueLaunchQueueTails.delete(sessionName);
  };
}
// `label` names the spawned command in the thrown/logged failure messages; launchWorkflowRunHerdr
// passes "lh workflow start" so a workflow-run failure is reported against the right command (#1007).
function runLhDevLaunch(
  args: string[],
  cwd: string,
  label = "lh workflow start",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("lh", args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const chunks: Buffer[] = [];
    let captured = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      if (captured >= LH_DEV_STDERR_TAIL_BYTES) return; // keep draining, stop keeping
      // Slice a single oversized chunk down to the remaining room — pushing it whole would let
      // captured exceed LH_DEV_STDERR_TAIL_BYTES despite the cap check above only running between
      // chunks, not within one (#584 review).
      const room = LH_DEV_STDERR_TAIL_BYTES - captured;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(piece);
      captured += piece.length;
    });
    child.stderr?.on("error", () => {
      // Losing the stderr stream only means the failure detail below is missing; `close` still
      // decides success/failure, so just stop this from becoming an unhandled stream error.
    });
    // Server-side only — never interpolated into a thrown ServiceError (see the const's comment).
    const logStderrTail = () => {
      const tail = Buffer.concat(chunks).toString("utf8").trim();
      if (tail) console.error(`${label} --herdr failed:\n${tail}`);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => {
        logStderrTail();
        reject(
          new ServiceError(
            500,
            `${label} timed out after ${LH_DEV_HERDR_TIMEOUT_MS}ms`,
          ),
        );
      });
    }, LH_DEV_HERDR_TIMEOUT_MS);
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      settle(() =>
        reject(
          code === "ENOENT"
            ? new ServiceError(422, "lh command not found on PATH")
            : new ServiceError(
                500,
                `failed to launch ${label} (${code ?? "spawn error"})`,
              ),
        ),
      );
    });
    child.on("close", (status, signal) => {
      settle(() => {
        if (signal == null && status === 0) return resolve();
        logStderrTail();
        if (signal != null)
          reject(
            new ServiceError(
              500,
              `${label} was terminated by signal ${signal}`,
            ),
          );
        else
          reject(
            new ServiceError(500, `${label} exited with status ${status}`),
          );
      });
    });
  });
}

// Spawns `lh workflow start <owner>/<repo>/<n> --workflow-id <id> --herdr` for the issue-detail
// Start workflow dropdown (#1007). This RPC only spawns the CLI
// and lets `lh workflow start` own worktree/PR provisioning, the dev lock, run creation, and the
// parent herdr launch (workflow design: CLI / UI). Args are passed as an array (no shell),
// so repo and id need no shell quoting; parent session id is never surfaced here — the CLI sets
// LOOPHUB_SESSION_ID for attribution.
async function launchWorkflowRunHerdr(
  r: S.Repo,
  issueNumber: number,
  workflowId: number,
): Promise<TerminalLaunchResultWire> {
  const repo = { full_name: r.full_name, local_path: r.local_path };
  const args = [
    "workflow",
    "start",
    `${r.full_name}/${issueNumber}`,
    "--workflow-id",
    String(workflowId),
    "--herdr",
  ];
  try {
    await runLhDevLaunch(args, r.local_path, "lh workflow start");
  } catch (e) {
    if (isServiceError(e))
      throw new ServiceError(e.status, e.message, {
        command: `lh ${args.map(displayArg).join(" ")}`,
      });
    throw e;
  }
  const sessionName = herdrSessionName(repo);
  // `herdr session attach <repoSession>` is the repo's canonical herdr entry point for launched
  // agents. The web client discards these fields today (only
  // the error-path `command` is read); a follow-up could pin the Workflow parent to this session in
  // `lh workflow start` for exact grouping (workflow design: CLI / UI).
  return {
    backend: "herdr" as const,
    session_name: sessionName,
    attach: `herdr session attach ${sessionName}`,
  };
}

// Runs one step of a herdr launch plan for lh-web. Async (never spawnSync — this is the single
// process serving RPC for every client) and non-throwing, because executeHerdrLaunchPlan decides
// what a failure means: it retries only `agent_pane_busy`, which it reads out of stderr. That
// stderr stays here — see herdrLaunchFailureMessage for what a client is allowed to see.
function serviceHerdrLaunchRunner(cwd: string): HerdrLaunchRunner {
  return async (argv) => {
    try {
      const stdout = await runHerdr(argv[0], argv.slice(1), cwd, {
        captureStdout: true,
        captureStderr: true,
        timeoutMs: 30_000,
      });
      return { stdout, stderr: "", ok: true };
    } catch (e) {
      return {
        stdout: "",
        stderr: isHerdrExitError(e) ? e.stderr : "",
        ok: false,
      };
    }
  };
}

// The client-facing reason a launch failed. Deliberately says only *which step* failed and never
// echoes herdr's stdout/stderr, which can embed the repo's absolute local_path (see runHerdr).
function herdrLaunchFailureMessage(outcome: HerdrLaunchOutcome): string {
  if (outcome.failed === "pane")
    return "Herdr could not create the agent's pane";
  if (outcome.failed === "prompt")
    return "Herdr started the agent but could not deliver its prompt";
  return "Herdr could not start the agent";
}

// The synthetic "repo" the global New workflow launch uses to name its herdr session and pick a cwd
// (#1889). A workflow is global — `lh workflow create` takes no repo — so there is no real repo row
// to pin to; the agent runs from LoopHub home so `lh workflow create` resolves the same DB every
// launch shares. full_name only feeds the session name (herdrSessionName hashes it with local_path),
// so a fixed label keeps every New workflow launch in one dedicated session.
function workflowCreateLaunchRepo(): TerminalLaunchRepo {
  return { full_name: "loophub", local_path: configDir() };
}

// New workflow (Settings > Workflows, #1889): launch a coding agent that gathers the workflow
// fields and runs `lh workflow create`, mirroring the New issue AI-driven flow. Global, so it has no
// repo/worktree — it opens a fresh herdr workspace at the LoopHub-home cwd and starts the agent
// there. Same best-effort placement + failure cleanup as the non-issue-create launches above:
// workspace-create is best-effort (fall back to a split), and any agent-start failure closes the
// tab/workspace it created.
async function launchWorkflowCreateHerdr(
  input: TerminalLaunchInput,
): Promise<TerminalLaunchResultWire> {
  const repo = workflowCreateLaunchRepo();
  const command = commandForHerdrLaunch({
    repo: repo.full_name,
    workflow: "workflow-create",
    codingAgent: input.agent,
    model: input.model,
    prompt: input.prompt,
  });
  if (!command.trim()) throw new ServiceError(422, "prompt is required");

  // Give the agent its own fresh workspace instead of piling onto whatever pane is focused (#544).
  // Only the workspace is created here: the launch creates its own tab inside it (that is where the
  // agent's pane, and its environment, come from since herdr 0.7.5).
  let workspaceId: string | null = null;
  let seedTabId: string | null = null;
  try {
    const create = herdrWorkspaceCreateArgv(repo);
    const out = await runHerdr(create[0], create.slice(1), repo.local_path, {
      captureStdout: true,
      timeoutMs: 10_000,
    });
    workspaceId = parseHerdrWorkspaceId(out);
    seedTabId = parseHerdrTabId(out);
  } catch {
    // Best-effort: fall back to a plain tab at the launch cwd below.
    workspaceId = null;
    seedTabId = null;
  }

  const plan = buildHerdrLaunchPlan({
    repo,
    command,
    program: agentProgramForHerdrLaunch({
      repo: repo.full_name,
      workflow: "workflow-create",
      codingAgent: input.agent,
      model: input.model,
      prompt: input.prompt,
    }),
    label: input.label,
    workspaceId,
  });
  const outcome = await executeHerdrLaunchPlan(
    plan,
    serviceHerdrLaunchRunner(plan.cwd),
  );
  if (!outcome.ok) {
    // herdr refuses to close a workspace's last tab, so a workspace this launch created is closed
    // wholesale rather than tab by tab.
    const cleanupArgv = workspaceId
      ? herdrWorkspaceCloseArgv(repo, workspaceId)
      : outcome.tabId
        ? herdrTabCloseArgv(repo, outcome.tabId)
        : null;
    if (cleanupArgv)
      runHerdrLaunch(
        cleanupArgv[0],
        cleanupArgv.slice(1),
        repo.local_path,
      ).catch(() => {});
    throw new ServiceError(500, herdrLaunchFailureMessage(outcome), {
      command: herdrCommandLine(plan),
      session: plan.sessionName,
    });
  }
  // Drop the empty tab the workspace was seeded with (the launch could not use it — a seeded tab
  // carries none of the launch's own `--env`). Creation and launch stay `--no-focus` so this
  // background agent does not interrupt the operator's current workspace, tab, or pane.
  if (workspaceId) {
    if (seedTabId) {
      const seedClose = herdrTabCloseArgv(repo, seedTabId);
      runHerdrLaunch(seedClose[0], seedClose.slice(1), repo.local_path).catch(
        () => {},
      );
    }
  }
  return {
    backend: "herdr" as const,
    session_name: plan.sessionName,
    command: plan.command,
    cwd: plan.cwd,
    attach: `herdr session attach ${plan.sessionName}`,
  };
}

// A terminal-aware agent row: the parsed herdr agent plus what the DB knows about the PR its
// worktree cwd resolves to (#611). `pull_closed` is true when that PR is merged or closed —
// clients can mute those rows so no-longer-needed agents stand out at a glance. An
// agent with no resolvable PR (repo-root cwd, legacy worktree convention, or a pr-<n> dir
// with no matching PR row) stays false: unknown must render as a normal row, not a stale one.
export type HerdrRepoSessions = HerdrRepoSessionsWire;
export type HerdrSessionsResult = HerdrSessionsWire;

// Resolves the on-disk worktree path herdr's `worktree open` should target for a launch (#551),
// so herdr's own workspace/worktree metadata is pinned to the PR's real worktree instead of a
// plain tab the launched command cd's into. Best-effort: returns null when the workflow has no
// worktree (issue-create) or resolving it fails for any reason — the caller falls back to the
// plain repo-root tab-create, same as any other herdr failure.
//
// workflow-run (Start workflow) has no case here: worktree/PR provisioning is entirely
// `lh workflow start --herdr`'s responsibility (#1007), which spawns it directly instead of routing
// through this tab/workspace-pinning path at all.
async function resolveHerdrWorktreeTarget(
  r: S.Repo,
  input: TerminalLaunchInput,
): Promise<string | null> {
  try {
    if (input.workflow === "github-pr-export" && input.prNumber) {
      const prRow = issueOr404(r, input.prNumber, "pull");
      const headRef = S.getPull(prRow.id)!.head_ref;
      const identity = resolveWorktreeIdentity(headRef, input.prNumber);
      return identity.scheme === "legacy-issue"
        ? legacyWorktreePath(worktreeRoot(), r.full_name, identity.number)
        : worktreePath(worktreeRoot(), r.full_name, identity.number);
    }
  } catch {
    // Repo not writable, issue/PR not found, worktree provisioning error, … — none of these
    // should fail the launch itself, only mean herdr won't get worktree metadata for it.
  }
  return null;
}

// Wraps runHerdr as the injected runner the core worktree-launch orchestration expects: a rejected
// runHerdr (non-zero exit, ENOENT, signal, timeout) becomes `ok:false` so the orchestration falls
// back instead of throwing — the same best-effort tolerance the direct herdr calls in launch() have.
// 10s per call, matching those. runHerdr resolves "" when captureStdout is unset, so the id-parsing
// steps get the empty string they treat as unparseable.
function herdrRunner(cwd: string): HerdrCmdRunner {
  return async (argv, opts) => {
    try {
      const stdout = await runHerdr(argv[0], argv.slice(1), cwd, {
        captureStdout: opts?.captureStdout,
        timeoutMs: 10_000,
      });
      return { stdout, ok: true };
    } catch {
      return { stdout: "", ok: false };
    }
  };
}

// Opens (or reuses) the herdr workspace pinned to `worktreeCheckoutPath`, the workspace this
// launch then creates its tab in. The parsing-heavy dance lives in
// core/terminal/terminal-launch.ts's acquireHerdrWorktreeWorkspace so `lh workflow start --herdr`
// reuses it (#674); this thin wrapper binds it to runHerdr at the repo's local path. `cwd` is where
// the herdr client is spawned — irrelevant to the `--session`-scoped calls themselves, but kept as
// r.local_path for consistency with the rest of terminal.launch.
function acquireHerdrWorktreeWorkspace(
  repo: TerminalLaunchRepo,
  cwd: string,
  worktreeCheckoutPath: string,
) {
  return acquireHerdrWorktreeWorkspaceCore(
    repo,
    worktreeCheckoutPath,
    herdrRunner(cwd),
  );
}

// ===== terminal launch =====
export const terminal = {
  async launch(input: TerminalLaunchInput): Promise<TerminalLaunchResultWire> {
    // New workflow (Settings > Workflows) is global: `lh workflow create` takes no repo, so this
    // launch has none to pin to. It runs from the LoopHub-home cwd instead and skips all the
    // repo/worktree machinery below (#1889). Worker compatibility deliberately gates only
    // workflow-run below; it must not broaden into general terminal health management.
    if (input.workflow === "workflow-create")
      return launchWorkflowCreateHerdr(input);
    if (!input.repo) throw new ServiceError(422, "repo is required");
    const r = repoOr404(input.repo);

    // workflow-run (Start workflow): worktree/PR/lock/run provisioning and the parent
    // herdr launch are entirely `lh workflow start`'s job (#1007) — this RPC only spawns it.
    // Short-circuits before any of the tab/workspace-pinning machinery below, which the other
    // workflows still use. Keep the protection here limited to rejecting a new run; restarting or
    // otherwise recovering the worker remains an explicit operator action.
    if (input.workflow === "workflow-run") {
      if (!input.issueNumber)
        throw new ServiceError(422, "issueNumber is required");
      if (!input.workflowId)
        throw new ServiceError(422, "workflowId is required");
      const compatibility = workerCompatibility(S.getWorkerRuntime());
      if (compatibility.status !== "compatible") {
        const observed =
          compatibility.observed_protocol_version === null
            ? "unknown"
            : String(compatibility.observed_protocol_version);
        throw new ServiceError(
          409,
          `lh-worker is ${compatibility.status}; start or restart it before starting a workflow (required protocol ${compatibility.required_protocol_version}, observed ${observed})`,
        );
      }
      return launchWorkflowRunHerdr(r, input.issueNumber, input.workflowId);
    }

    const issueCreateLaunchId =
      input.workflow === "issue-create" ? randomUUID() : null;
    const command = commandForHerdrLaunch({
      repo: r.full_name,
      workflow: input.workflow,
      prNumber: input.prNumber,
      codingAgent: input.workflow === "issue-create" ? input.agent : undefined,
      model: input.workflow === "issue-create" ? input.model : undefined,
      effort: input.workflow === "issue-create" ? input.effort : undefined,
      targetBranch:
        input.workflow === "issue-create" ? input.targetBranch : undefined,
      // Interactive creation and github-pr-export (#1892) inject their full instructions directly
      // as the agent prompt.
      prompt:
        input.workflow === "issue-create" ||
        input.workflow === "github-pr-export"
          ? input.prompt
          : undefined,
      env:
        issueCreateLaunchId != null
          ? { [ENV_ISSUE_CREATE_HERDR_LAUNCH]: issueCreateLaunchId }
          : undefined,
    });
    if (!command.trim()) throw new ServiceError(422, "command is required");

    const repo = { full_name: r.full_name, local_path: r.local_path };

    // New Issue launches share one labelled workspace per repo session. They have no PR worktree
    // to pin to. Worktree-backed workflows instead open a workspace pinned to the PR's real
    // worktree (#551, below).
    const isNewIssue = input.workflow === "issue-create";
    const usesRepoRootWorkspace = isNewIssue;
    let releaseNewIssueLaunch = isNewIssue
      ? await acquireNewIssueLaunchLock(herdrSessionName(repo))
      : null;
    const releaseNewIssueLaunchNow = () => {
      releaseNewIssueLaunch?.();
      releaseNewIssueLaunch = null;
    };
    // Resolve the workspace the launch belongs in first, so the agent's tab is created there
    // instead of wherever herdr's focus happens to be (#489). Best-effort: on any failure fall
    // back to a plain tab at the repo root rather than breaking the launch; a hard herdr failure
    // still surfaces from the launch below. The timeout keeps a wedged herdr call from hanging the
    // RPC forever — runHerdr kills it and the catch falls back.
    //
    // The launch always creates its own tab inside this workspace. Since herdr 0.7.5 the agent runs
    // in a pane that already exists, and the only way to give that pane the launch's environment is
    // to set it when the pane is created — which the workspace/worktree seeding calls cannot do.
    let placementWorkspaceId: string | null = null;
    // The workspace this launch *owns*: the issue-create `workspace create`, or a first-time
    // `worktree open` (#551). It is the cleanup target if the launch fails (herdr refuses to close
    // a workspace's last tab, so the whole workspace goes). New Issue also brings it forward on
    // success; other workflows leave focus unchanged.
    // Null when an already-open workspace was merely reused — that one predates this launch.
    let workspaceId: string | null = null;
    // The empty tab such a fresh workspace was seeded with, closed once the launch's own tab exists.
    let seedTabId: string | null = null;
    let createdWorkspace = false;
    let newIssuePlacementArgv: string[] | null = null;
    try {
      if (usesRepoRootWorkspace) {
        let existingWorkspaceId: string | null = null;
        if (isNewIssue) {
          const list = herdrWorkspaceListArgv(repo);
          newIssuePlacementArgv = list;
          let listed: string | null = null;
          try {
            listed = await runHerdr(list[0], list.slice(1), r.local_path, {
              captureStdout: true,
              timeoutMs: 10_000,
            });
          } catch (error) {
            if (!isHerdrExitError(error) || error.exitStatus !== 1) throw error;
            // `workspace list` exits 1 when the named repo session does not exist yet. Confirm
            // that state through the session registry before creating: an exit 1 from a still-
            // running session is a real placement failure and stays visible.
            let runningSessions: string[] | null = null;
            try {
              const sessionList = ["herdr", "session", "list", "--json"];
              const sessionsOut = await runHerdr(
                sessionList[0],
                sessionList.slice(1),
                r.local_path,
                { captureStdout: true, timeoutMs: 10_000 },
              );
              runningSessions = parseHerdrSessionListIfValid(sessionsOut);
            } catch {
              // Without a trustworthy absence check, keep the original workspace-list failure
              // visible instead of risking a duplicate workspace through automatic recovery.
            }
            if (
              runningSessions === null ||
              runningSessions.includes(herdrSessionName(repo))
            )
              throw error;
            const server = [
              "herdr",
              "--session",
              herdrSessionName(repo),
              "server",
            ];
            newIssuePlacementArgv = server;
            await startHerdrSession(herdrSessionName(repo), r.local_path);
          }
          if (listed !== null) {
            const workspaces = parseHerdrWorkspaceListIfValid(listed);
            if (workspaces === null)
              throw new ServiceError(
                500,
                "Herdr workspace list returned an invalid response",
              );
            existingWorkspaceId =
              workspaces.find(
                (workspace) =>
                  workspace.label === NEW_ISSUE_WORKSPACE_LABEL &&
                  HERDR_ID.test(workspace.id),
              )?.id ?? null;
          }
        }
        if (existingWorkspaceId) {
          // The shared New issue workspace already exists; the launch adds its own tab to it.
          placementWorkspaceId = existingWorkspaceId;
        } else {
          const placement = herdrWorkspaceCreateArgv(
            repo,
            isNewIssue ? NEW_ISSUE_WORKSPACE_LABEL : undefined,
          );
          if (isNewIssue) newIssuePlacementArgv = placement;
          const out = await runHerdr(
            placement[0],
            placement.slice(1),
            r.local_path,
            { captureStdout: true, timeoutMs: 10_000 },
          );
          workspaceId = parseHerdrWorkspaceId(out);
          placementWorkspaceId = workspaceId;
          seedTabId = parseHerdrTabId(out);
          createdWorkspace = true;
        }
      } else {
        // Worktree-backed workflows (github-pr-export, #551) open the herdr
        // workspace directly at the PR's real worktree path, so herdr's own workspace/worktree
        // metadata reflects it — instead of a plain repo-root tab the launched command cd's
        // into. Falls back to that plain tab below when there is no resolvable worktree path
        // or the worktree-open attempt itself fails for any reason.
        const worktreeTarget = await resolveHerdrWorktreeTarget(r, input);
        const acquired = worktreeTarget
          ? await acquireHerdrWorktreeWorkspace(
              repo,
              r.local_path,
              worktreeTarget,
            )
          : null;
        if (acquired) {
          placementWorkspaceId = acquired.workspaceId;
          workspaceId = acquired.createdWorkspace ? acquired.workspaceId : null;
          seedTabId = acquired.seedTabId;
          createdWorkspace = acquired.createdWorkspace;
        }
      }
      // Zero exit with no parseable id means a workspace was likely created but can't be closed on
      // failure (no id) — every such launch leaks one empty workspace. Log server-side (never to
      // the client) so a herdr output-format drift is noticed instead of silently leaking them.
      if (createdWorkspace && !workspaceId)
        console.error(
          "herdr workspace create succeeded but its output had no usable workspace id; failure cleanup may be unable to remove it",
        );
    } catch (error) {
      releaseNewIssueLaunchNow();
      if (isNewIssue) {
        if (isServiceError(error) && newIssuePlacementArgv)
          throw new ServiceError(error.status, error.message, {
            command: newIssuePlacementArgv.map(displayArg).join(" "),
            session: isHerdrExitError(error)
              ? herdrSessionName(repo)
              : undefined,
          });
        throw error;
      }
      placementWorkspaceId = null;
      workspaceId = null;
      seedTabId = null;
      createdWorkspace = false;
    }
    releaseNewIssueLaunchNow();
    // A freshly created workspace whose id failed to parse can never be closed, so it would sit
    // orphaned forever. It is still usable as a placement only if its id parsed; without it the
    // launch falls back to a plain tab rather than adding an untrackable second orphan.
    if (createdWorkspace && !workspaceId) placementWorkspaceId = null;

    const plan = buildHerdrLaunchPlan({
      repo,
      command,
      program: agentProgramForHerdrLaunch({
        repo: r.full_name,
        workflow: input.workflow,
        prNumber: input.prNumber,
        codingAgent: input.agent,
        model: input.model,
        prompt: input.prompt,
      }),
      label: input.label,
      workspaceId: placementWorkspaceId,
    });
    // Non-blocking: lh-web is a single process serving RPC for every client, so a
    // synchronous spawnSync here would stall the whole server for as long as the Herdr launch
    // takes (or hangs).
    const outcome = await executeHerdrLaunchPlan(
      plan,
      serviceHerdrLaunchRunner(plan.cwd),
    );
    if (!outcome.ok) {
      // Don't leave the workspace/tab this launch created behind; fire-and-forget cleanup. herdr
      // refuses to close a workspace's last remaining tab, so a workspace this launch created is
      // closed wholesale. The New issue workspace is shared across launches and deliberately
      // outlives a failed one, so it is never torn down here.
      const cleanupArgv =
        workspaceId && !isNewIssue
          ? herdrWorkspaceCloseArgv(repo, workspaceId)
          : outcome.tabId
            ? herdrTabCloseArgv(repo, outcome.tabId)
            : null;
      if (cleanupArgv)
        runHerdrLaunch(
          cleanupArgv[0],
          cleanupArgv.slice(1),
          r.local_path,
        ).catch(() => {});
      // Attach the `herdr ...` invocations (not plan.command, which is only the inner workflow
      // command herdr would run) so the client can re-run them locally and see the full output
      // itself — this rides on top of the deliberately generic message (see the comment on
      // runHerdr above), so the client still never sees raw stdout/stderr/paths.
      throw new ServiceError(500, herdrLaunchFailureMessage(outcome), {
        command: herdrCommandLine(plan),
        session: plan.sessionName,
      });
    }
    if (issueCreateLaunchId != null && outcome.paneId) {
      const registeredPane = db.transaction(() =>
        S.upsertIssueHerdrPane({
          launchId: issueCreateLaunchId,
          repoId: r.id,
          paneId: outcome.paneId,
          sessionName: plan.sessionName,
        }),
      );
      // The launch RPC must not wait for cleanup subprocesses. This only handles the rare
      // issue-created-and-closed-before-registration ordering; failures stay visible in the
      // server log and are not retried.
      closeManagedHerdrPaneIfUnclaimed(r, registeredPane.id).then(
        (cleanup) => {
          if (cleanup === "failed") {
            console.error(
              `New Issue pane cleanup failed after late registration for ${r.full_name}`,
            );
          }
        },
        (error) => {
          console.error(
            `New Issue pane cleanup error after late registration for ${r.full_name}:`,
            error,
          );
        },
      );
    }
    // A newly created workspace is seeded with an empty tab that cannot carry the launch's `--env`;
    // drop it once the real tab exists. Only New Issue brings its completed agent forward (#556,
    // #625). Every other launch keeps the create/open/tab-create `--no-focus` behavior so the
    // operator's current workspace, tab, and pane remain selected. Focus remains fire-and-forget:
    // the agent is already running, so a focus failure must not fail a New Issue launch.
    if (createdWorkspace && workspaceId) {
      if (seedTabId) {
        const seedClose = herdrTabCloseArgv(repo, seedTabId);
        runHerdrLaunch(seedClose[0], seedClose.slice(1), r.local_path).catch(
          () => {},
        );
      }
      if (isNewIssue) {
        const focus = herdrWorkspaceFocusArgv(repo, workspaceId);
        runHerdrLaunch(focus[0], focus.slice(1), r.local_path).catch(() => {});
      }
    } else if (isNewIssue && outcome.tabId) {
      const focus = herdrTabFocusArgv(repo, outcome.tabId);
      runHerdrLaunch(focus[0], focus.slice(1), r.local_path).catch(() => {});
    }
    return {
      backend: "herdr" as const,
      session_name: plan.sessionName,
      command: plan.command,
      cwd: plan.cwd,
      attach: `herdr session attach ${plan.sessionName}`,
    };
  },

  // Running herdr sessions grouped by repo, for terminal-aware UI surfaces (#495). As of #1665 this
  // is a pure read of the worker-owned snapshot (herdr_session_snapshots): lh-worker's global sweep
  // (snapshotHerdrSessions) does the herdr subprocess capture, so this RPC spawns nothing regardless
  // of how many browser tabs poll it. Read-only and deliberately failure-tolerant: no snapshot yet
  // (worker never ran) degrades to an empty list with captured_at: null, and clients surface the
  // captured_at staleness rather than an automatic herdr fallback that would hide a stopped worker.
  sessions(): HerdrSessionsResult {
    const snapshot = S.getHerdrSessionSnapshot();
    if (!snapshot) return { repos: [], captured_at: null };
    return { ...snapshot.snapshot, captured_at: snapshot.captured_at };
  },

  // lh-worker tick (#1665): capture the live herdr snapshot into the DB and emit
  // terminal.sessions_updated only when the displayed state changed. Kept in the terminal service
  // (not the worker) so the herdr orchestration stays in core and unit-testable.
  async snapshotHerdrSessions(): Promise<HerdrSnapshotSweepResult> {
    return snapshotHerdrSessionsImpl();
  },

  async cleanupClosedIssuePanes(input: {
    repo: string;
    issueNumber: number;
  }): Promise<{
    closed: number;
    skipped: number;
    failed: number;
  }> {
    if (!input.repo) throw new ServiceError(422, "repo is required");
    if (!Number.isFinite(input.issueNumber) || input.issueNumber <= 0)
      throw new ServiceError(422, "issueNumber is required");
    return cleanupClosedIssuePanesImpl(
      input.repo,
      Math.trunc(input.issueNumber),
    );
  },

  // Kill development agents whose PR has been closed/merged for at least one hour (#926). Reuses
  // the same Herdr pane-kill primitive as the manual kill button and is scheduled by the existing
  // worker agent-maintenance tick, not by a PR-specific timer.
  async cleanupClosedPullDevAgents(): Promise<{
    killed: number;
    skipped: number;
    failed: number;
  }> {
    return cleanupClosedPullDevAgentsImpl();
  },

  // Recent terminal output for one herdr agent, for client-side terminal previews (#500).
  // `target` is whatever the client sends as a herdr `agent read` target — usually a
  // pane_id, since herdr only resolves an agent *name* target when it's unique within
  // the session, and two label-less launches can share a display name. Same failure-tolerance as
  // sessions() above: herdr not running, the session gone, or the agent no longer
  // present all degrade to a null output instead of an error, so the client just
  // doesn't show a preview.
  async agentRead(input: {
    repo: string;
    target: string;
    lines?: number;
  }): Promise<{
    output: string | null;
    cols: number | null;
    rows: number | null;
  }> {
    if (!input.target) throw new ServiceError(422, "target is required");
    const lines = clampAgentReadLines(input.lines);
    let sessionName: string;
    try {
      sessionName = herdrSessionName(repoOr404(input.repo));
    } catch {
      return { output: null, cols: null, rows: null };
    }
    // Read and layout run independently: a target that's the display-name fallback (no real
    // pane_id — see NO_PANE_ID_PREFIX) resolves fine for `agent read` but not for `pane
    // layout --pane`, which only accepts a real pane id. That legitimately fails here (#531);
    // the read must still succeed, and the client falls back to its fixed preview size.
    const [output, layout] = await Promise.all([
      runHerdrCapture([
        "--session",
        sessionName,
        "agent",
        "read",
        input.target,
        "--source",
        "recent",
        "--lines",
        String(lines),
      ])
        .then(parseHerdrAgentRead)
        .catch(() => null),
      runHerdrCapture([
        "--session",
        sessionName,
        "pane",
        "layout",
        "--pane",
        input.target,
      ])
        .then(parseHerdrPaneLayout)
        .catch(() => null),
    ]);
    return { output, cols: layout?.cols ?? null, rows: layout?.rows ?? null };
  },

  // Kills the agent running in a pane (#521). This used to be `pane
  // close` against the agent's pane_id, but herdr refuses that with a `confirmation_required`
  // error ("closing this pane would close a worktree group") whenever the pane is the last one
  // in a worktree-linked workspace — which every single-tab `lh workflow start --herdr` launch is, by
  // default (#805). There is no CLI flag to force it through, so that refusal hard-blocked the
  // kill button. Killing the pane's foreground process directly (killPaneForegroundProcess)
  // sidesteps pane/tab/workspace state entirely, so it can never hit that guard. Unlike
  // sessions() above, failures here must reach the client (silently swallowing a kill the user
  // asked for would be worse than a visible error), so this rejects with the ServiceError as-is
  // instead of degrading to a default.
  async killAgent(input: { repo: string; paneId: string }): Promise<{
    ok: true;
  }> {
    if (!input.repo) throw new ServiceError(422, "repo is required");
    if (!input.paneId) throw new ServiceError(422, "paneId is required");
    if (input.paneId.startsWith(NO_PANE_ID_PREFIX))
      throw new ServiceError(
        422,
        "This agent has no pane id available to close",
      );
    // Unlike tab/pane ids parsed from herdr's own stdout (parseHerdrTabId /
    // parseHerdrRootPaneId), paneId here comes straight from an external JSON-RPC caller —
    // reject anything that doesn't look like a real herdr id before it reaches the argv.
    if (!HERDR_ID.test(input.paneId))
      throw new ServiceError(422, "paneId is not a valid herdr pane id");
    const r = repoOr404(input.repo);
    await killPaneForegroundProcess(r, input.paneId);
    // Best-effort tidy-up: the process is already dead either way, so a `confirmation_required`
    // refusal here (or any other herdr failure) must not undo the kill the caller already got —
    // this only saves the now-empty pane from lingering in clients. Keep the fire-and-forget
    // call bounded so a wedged herdr client cannot outlive runHerdr's timeout guard.
    const argv = herdrPaneCloseArgv(r, input.paneId);
    runHerdr(argv[0], argv.slice(1), r.local_path, { timeoutMs: 10_000 }).catch(
      () => {},
    );
    return { ok: true };
  },

  // Switches herdr's focus to a running agent's pane — the issue-list "Herdr running" badge's
  // click action (#579). Like killAgent above, a user-initiated action must fail visibly rather
  // than degrade silently.
  async focusAgent(input: { repo: string; paneId: string }): Promise<{
    ok: true;
  }> {
    if (!input.repo) throw new ServiceError(422, "repo is required");
    if (!input.paneId) throw new ServiceError(422, "paneId is required");
    // paneId comes straight from an external JSON-RPC caller (unlike the ids this module parses
    // from herdr's own stdout elsewhere) — reject anything that doesn't look like a real herdr
    // id before it reaches an argv, same guard as killAgent's paneId.
    if (!HERDR_ID.test(input.paneId))
      throw new ServiceError(422, "paneId is not a valid herdr pane id");
    const r = repoOr404(input.repo);
    const argv = herdrAgentFocusArgv(r, input.paneId);
    await runHerdr(argv[0], argv.slice(1), r.local_path, {
      timeoutMs: 10_000,
    });
    return { ok: true };
  },

  // Sends one user-authored message to the live agent for a PR. The client supplies the pane id it
  // learned from terminal.sessions, but that id is only a hint: re-read Herdr and verify the pane's
  // cwd still maps to this repo and PR immediately before writing. This prevents stale UI state or
  // a crafted RPC call from targeting another worktree's pane.
  async sendAgentInput(input: {
    repo: string;
    pull: number;
    paneId: string;
    text: string;
  }): Promise<{ ok: true }> {
    if (!input.repo) throw new ServiceError(422, "repo is required");
    if (!Number.isInteger(input.pull) || input.pull <= 0)
      throw new ServiceError(422, "pull is required");
    if (!input.paneId) throw new ServiceError(422, "paneId is required");
    if (!HERDR_ID.test(input.paneId))
      throw new ServiceError(422, "paneId is not a valid herdr pane id");
    if (typeof input.text !== "string" || input.text.trim() === "")
      throw new ServiceError(422, "text is required");
    if (/\r|\n/.test(input.text))
      throw new ServiceError(422, "text must be a single line");

    const r = repoOr404(input.repo);
    const pullNumber = input.pull;
    const pullIssue = S.getIssue(r.id, pullNumber);
    if (pullIssue?.kind !== "pull")
      throw new ServiceError(404, `PR #${pullNumber} not found`);

    let agentsOut: string;
    try {
      agentsOut = await runHerdrCapture([
        "--session",
        herdrSessionName(r),
        "pane",
        "list",
      ]);
    } catch (e) {
      if (isServiceError(e) && e.status === 422) throw e;
      throw new ServiceError(409, "The Herdr session is no longer available");
    }
    const workspace = herdrPullWorkspacesFromAgentList(
      agentsOut,
      worktreeRoot(),
      r.full_name,
    ).find((candidate) => candidate.pull === pullNumber);
    if (!workspace || workspace.pane_id !== input.paneId)
      throw new ServiceError(
        409,
        "The Herdr agent is no longer running for this PR",
      );

    try {
      await sendHerdrPrompt({
        sessionName: herdrSessionName(r),
        paneId: input.paneId,
        text: input.text,
        cwd: r.local_path,
        timeoutMs: 10_000,
      });
    } catch (e) {
      throw new ServiceError(
        409,
        isHerdrPromptError(e) && e.phase === "submit"
          ? "The input was written, but Herdr could not submit it; check the pane before retrying"
          : "The Herdr agent disappeared before the input could be sent",
      );
    }
    return { ok: true };
  },
};

const HERDR_AGENT_READ_DEFAULT_LINES = 40;
const HERDR_AGENT_READ_MAX_LINES = 300;

function clampAgentReadLines(lines: number | undefined): number {
  if (!Number.isFinite(lines) || !lines) return HERDR_AGENT_READ_DEFAULT_LINES;
  return Math.min(
    Math.max(Math.trunc(lines as number), 1),
    HERDR_AGENT_READ_MAX_LINES,
  );
}
