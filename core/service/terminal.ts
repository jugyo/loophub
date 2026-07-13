import {
  COST_STOP_REASON,
  DEV_COST_STOPPED_EVENT,
  decideCostStop,
} from "../cost-stop.ts";
import {
  runHerdr,
  runHerdrCapture,
  runHerdrLaunch,
  runHerdrLaunchCapture,
} from "./herdr-runner.ts";
import type {
  CodingAgent,
  HerdrAgent,
  HerdrCmdRunner,
  HerdrIssueWorkspace,
  HerdrPullWorkspace,
  TerminalLaunchRepo,
} from "./shared.ts";
import {
  acquireHerdrWorktreeTabCore,
  autoModeOnBuild,
  buildHerdrLaunchPlan,
  codingAgent,
  commandForHerdrLaunch,
  devCostLimitUsd,
  displayArg,
  ENV_ISSUE_CREATE_HERDR_LAUNCH,
  HERDR_ID,
  herdrAgentFocusArgv,
  herdrCommandLine,
  herdrIssueWorkspacesFromAgentList,
  herdrPaneCloseArgv,
  herdrPaneSendKeysArgv,
  herdrPaneSendTextArgv,
  herdrPullWorkspacesFromAgentList,
  herdrSessionName,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrTabFocusArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceCreateArgv,
  herdrWorkspaceFocusArgv,
  isServiceError,
  issueOr404,
  legacyWorktreePath,
  NO_PANE_ID_PREFIX,
  paneRunsClaudeResume,
  parseHerdrAgentList,
  parseHerdrAgentPaneId,
  parseHerdrAgentPlacements,
  parseHerdrAgentRead,
  parseHerdrPaneKillTarget,
  parseHerdrPaneLayout,
  parseHerdrPaneProcessInfo,
  parseHerdrRootPaneId,
  parseHerdrSessionList,
  parseHerdrSessionListIfValid,
  parseHerdrTabId,
  parseHerdrWorkspaceId,
  RUNTIMES,
  randomUUID,
  repoOr404,
  reposWithRunningSession,
  resolveWorktreeIdentity,
  S,
  ServiceError,
  spawn,
  worktreePath,
  worktreeRoot,
} from "./shared.ts";

export interface TerminalLaunchInput {
  repo: string;
  label?: string;
  workflow?:
    | "issue-dev"
    | "issue-create"
    | "scheduled-task-create"
    | "resume"
    | "github-pr-export"
    | "workflow-run";
  issueNumber?: number;
  prNumber?: number;
  // Saved workflow id for the "workflow-run" launch (#1007). Set by the issue-detail Start
  // workflow dropdown; maps to `lh workflow start ... --workflow-id <id>`.
  workflowId?: number;
  session?: string;
  cwd?: string;
  // One-shot agent/model overrides from the issue-dev (Build) or issue-create (New issue)
  // dropdowns (#637, #1275). Plain buttons leave these unset. They map to the corresponding CLI
  // runtime/model flags and never touch persisted Settings defaults.
  agent?: CodingAgent;
  model?: string;
  // Opt-in parallel attempt from issue detail (#1140). The ordinary Build paths leave this unset,
  // preserving the existing open-PR reuse behavior in `lh build`.
  newAttempt?: boolean;
}

// Spawns `lh build ... --herdr` for the Build button (#584). This is not routed through runHerdr:
// that helper's error messages are hardcoded around the `herdr` binary ("herdr command not found
// on PATH", "Herdr exited with status N", …), which would misreport a failure of `lh` itself (a
// missing PATH entry, an issue lookup failure, a worktree provisioning error, …) as a Herdr
// problem. `lh build --herdr` owns worktree/PR provisioning and the actual herdr pane launch
// end-to-end (cli/index.ts), so this call only needs to await it and translate a non-zero exit.
//
// Generous relative to the individual 10s herdr-call timeouts elsewhere in this file: this one
// bounds the *whole* `lh build --herdr` run — issue lookup, PR open, worktree provisioning (a
// first-time `git worktree add` on a large repo), and the herdr launch itself — none of which
// carried an overall deadline before this call replaced the in-process equivalent (#584 review).
const LH_DEV_HERDR_TIMEOUT_MS = 90_000;
// Bounded tail of the child's stderr, logged server-side only (never in the thrown ServiceError)
// so an operator can see `lh build`'s actual failure reason (`fail(message)` etc.) without every
// failure collapsing to a bare "exited with status N" — but never reaching the HTTP client, same
// "deliberately generic" policy runHerdr documents above: raw process output can embed the
// server's absolute paths, a Node stack trace, or other detail that must not reach a non-loopback
// client (#584 review).
const LH_DEV_STDERR_TAIL_BYTES = 4 * 1024;
const CLOSED_PULL_AGENT_GRACE_MS = 60 * 60 * 1000;
const CLOSED_PULL_AGENT_KILLED_EVENT = "agent_session.killed";
const CLOSED_PULL_AGENT_KILL_REASON = "pr_closed_grace_elapsed";
// `label` names the spawned command in the thrown/logged failure messages. Defaults to the Build
// command since that was the original caller; launchWorkflowRunHerdr passes "lh workflow start" so a
// workflow-run failure is not misreported as an `lh build` failure (#1007).
function runLhDevLaunch(
  args: string[],
  cwd: string,
  label = "lh build",
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

// The Build button's whole job (#584): spawn `lh build <owner>/<repo>/<n> --herdr [--auto]` and let
// it provision the worktree/PR and launch the herdr pane itself — this server no longer does any
// of that (see the removed issue-dev case in resolveHerdrWorktreeTarget). session_name/attach are
// still computable up front since herdrSessionName only depends on the repo, not the worktree
// `lh build` resolves internally.
//
// `override` carries the issue-detail Build dropdown's one-shot agent/model choice (#637). When set
// it forces the runtime via --claude-code|--codex and the session model via --model, without
// touching the persisted `codingAgent` / `defaultModel` settings. The plain Build button passes no
// override, keeping the historical default-resolution behavior.
async function launchIssueDevHerdr(
  r: S.Repo,
  issueNumber: number,
  options?: {
    agent?: CodingAgent;
    model?: string;
    newAttempt?: boolean;
  },
) {
  const repo = { full_name: r.full_name, local_path: r.local_path };
  // The agent that actually runs: the dropdown override when present, else whichever agent `lh build`
  // would resolve to (the `codingAgent` setting). Auto-mode is read from *this* agent so a codex
  // override reads codex's auto setting, not claude-code's (#593).
  const agent = options?.agent ?? codingAgent();
  const model = options?.model?.trim();
  const args = [
    "build",
    `${r.full_name}/${issueNumber}`,
    ...(options?.newAttempt ? ["--new-attempt"] : []),
    "--herdr",
    // Force the runtime only when the dropdown overrode it; without an override we pass no runtime
    // flag so `lh build` resolves the default itself (unchanged plain-Build behavior). The per-runtime
    // flag comes from the registry (core/runtimes.ts buildFlag).
    ...(options?.agent ? [RUNTIMES[options.agent].buildFlag] : []),
    // One-shot session model (#637); omitted when the dropdown left it blank, so `lh build` falls
    // back to the configured per-agent default.
    ...(model ? ["--model", model] : []),
    ...(autoModeOnBuild(agent) ? ["--auto"] : []),
  ];
  try {
    await runLhDevLaunch(args, r.local_path);
  } catch (e) {
    if (isServiceError(e))
      throw new ServiceError(e.status, e.message, {
        command: `lh ${args.map(displayArg).join(" ")}`,
      });
    throw e;
  }
  const sessionName = herdrSessionName(repo);
  return {
    backend: "herdr" as const,
    session_name: sessionName,
    attach: `herdr session attach ${sessionName}`,
  };
}

// Spawns `lh workflow start <owner>/<repo>/<n> --workflow-id <id> --herdr --auto` for the issue-detail
// Start workflow dropdown (#1007). Same shape as launchIssueDevHerdr: this RPC only spawns the CLI
// and lets `lh workflow start` own worktree/PR provisioning, the dev lock, run creation, and the
// parent herdr launch (docs/workflow.ja.md §9.1–§9.2). Args are passed as an array (no shell),
// so repo and id need no shell quoting; parent session id is never surfaced here — the CLI sets
// LOOPHUB_SESSION_ID for attribution.
async function launchWorkflowRunHerdr(
  r: S.Repo,
  issueNumber: number,
  workflowId: number,
) {
  const repo = { full_name: r.full_name, local_path: r.local_path };
  const args = [
    "workflow",
    "start",
    `${r.full_name}/${issueNumber}`,
    "--workflow-id",
    String(workflowId),
    "--herdr",
    "--auto",
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
  // Same shape/convention as launchIssueDevHerdr: `herdr session attach <repoSession>` is the repo's
  // canonical herdr entry point for launched agents. The web client discards these fields today (only
  // the error-path `command` is read); a follow-up could pin the Workflow parent to this session in
  // `lh workflow start` for exact grouping (docs/workflow.ja.md §9.2).
  return {
    backend: "herdr" as const,
    session_name: sessionName,
    attach: `herdr session attach ${sessionName}`,
  };
}

// A terminal-aware agent row: the parsed herdr agent plus what the DB knows about the PR its
// worktree cwd resolves to (#611). `pull_closed` is true when that PR is merged or closed —
// clients can mute those rows so no-longer-needed agents stand out at a glance. An
// agent with no resolvable PR (repo-root cwd, legacy worktree convention, or a pr-<n> dir
// with no matching PR row) stays false: unknown must render as a normal row, not a stale one.
export interface HerdrSessionAgent extends HerdrAgent {
  // The PR number the agent's worktree cwd resolves to, or null for a no-PR agent (a
  // "New issue" agent at the repo root, #633). Clients use this to mute a no-PR
  // agent out on idle, since pull_closed is always false for it.
  pull: number | null;
  pull_closed: boolean;
}

export interface HerdrRepoSessions {
  repo: string;
  session_name: string;
  agents: HerdrSessionAgent[];
  // Running herdr workspaces pinned to a PR's worktree, keyed back to their PR number (#579) —
  // drives the issue-list "Herdr running" badge and its click-to-focus action.
  pull_workspaces: HerdrPullWorkspace[];
  // Same running workspaces resolved to the *issue* each PR closes (#821) — drives the
  // issue-detail "Agents" section (issue-herdr-section.tsx), the issue-keyed counterpart of
  // pull_workspaces. Built from pull_workspaces via the DB PR→issue link (see sweepHerdrSessions).
  issue_workspaces: HerdrIssueWorkspace[];
}

export interface HerdrSessionsResult {
  repos: HerdrRepoSessions[];
  // Active repos whose deterministic herdr session was present in a successful session-list
  // read. Optional so a failed read remains distinguishable from a confirmed empty list.
  running_repos?: string[];
}

function isIssueCreateAgentName(name: string): boolean {
  return (
    name === "New issue" ||
    name.startsWith("New issue - ") ||
    name.startsWith("New issue (")
  );
}

function isIssueCreateAgent(
  agent: { id: string; name: string; pull: number | null },
  issueCreatePaneIds: Set<string>,
): boolean {
  return (
    issueCreatePaneIds.has(agent.id) ||
    (agent.pull === null && isIssueCreateAgentName(agent.name))
  );
}

// Coalesces concurrent terminal.sessions calls onto one herdr sweep. Every client polls this
// RPC (15s interval per tab), so without sharing, N tabs would each spawn their own
// `herdr session list` + per-repo `agent list` process trees against the same state.
let herdrSessionsInflight: Promise<HerdrSessionsResult> | null = null;

// Resolves the on-disk worktree path herdr's `worktree open` should target for a launch (#551),
// so herdr's own workspace/worktree metadata is pinned to the PR's real worktree instead of a
// plain tab the launched command cd's into. Best-effort: returns null when the workflow has no
// worktree (issue-create) or resolving it fails for any reason — the caller falls back to the
// plain repo-root tab-create, same as any other herdr failure.
//
// issue-dev (Build) has no case here: worktree/PR provisioning is entirely `lh build --herdr`'s
// responsibility (#584) — see launchIssueDevHerdr, which spawns it directly instead of routing
// through this tab/workspace-pinning path at all.
async function resolveHerdrWorktreeTarget(
  r: S.Repo,
  input: TerminalLaunchInput,
): Promise<string | null> {
  try {
    if (input.workflow === "resume") {
      // The client already resolved the PR's worktree path (issue/pull detail's worktree_path,
      // #345); an issue-create session (no worktree) omits cwd and resumes from the repo root
      // instead, which is exactly what the repo-root tab-create fallback gives it.
      return input.cwd ?? null;
    }
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

// Opens (or reuses) the herdr workspace pinned to `worktreeCheckoutPath` and returns a tab safe to
// pass to `agent start --tab`. The parsing-heavy dance lives in core/terminal/terminal-launch.ts's
// acquireHerdrWorktreeTab so `lh build --herdr` reuses it (#674); this thin wrapper just binds it to
// runHerdr at the repo's local path. `cwd` is where the herdr client is spawned — irrelevant to the
// `--session`-scoped calls themselves, but kept as r.local_path for consistency with the rest of
// terminal.launch.
function acquireHerdrWorktreeTab(
  repo: TerminalLaunchRepo,
  cwd: string,
  worktreeCheckoutPath: string,
) {
  return acquireHerdrWorktreeTabCore(
    repo,
    worktreeCheckoutPath,
    herdrRunner(cwd),
  );
}

// ===== terminal launch =====
export const terminal = {
  config(): { backend: "herdr" } {
    return { backend: "herdr" };
  },

  async launch(input: TerminalLaunchInput) {
    if (!input.repo) throw new ServiceError(422, "repo is required");
    const r = repoOr404(input.repo);

    // issue-dev (Build): worktree/PR provisioning and the herdr launch are entirely `lh build
    // --herdr`'s job now (#584) — this RPC's only role is to spawn it. Short-circuits before any
    // of the tab/workspace-pinning machinery below, which the other workflows still use.
    if (input.workflow === "issue-dev") {
      if (!input.issueNumber)
        throw new ServiceError(422, "issueNumber is required");
      return launchIssueDevHerdr(r, input.issueNumber, {
        agent: input.agent,
        model: input.model,
        newAttempt: input.newAttempt,
      });
    }

    // workflow-run (Start workflow): like issue-dev, worktree/PR/lock/run provisioning and the parent
    // herdr launch are entirely `lh workflow start`'s job (#1007) — this RPC only spawns it.
    if (input.workflow === "workflow-run") {
      if (!input.issueNumber)
        throw new ServiceError(422, "issueNumber is required");
      if (!input.workflowId)
        throw new ServiceError(422, "workflowId is required");
      return launchWorkflowRunHerdr(r, input.issueNumber, input.workflowId);
    }

    const issueCreateLaunchId =
      input.workflow === "issue-create" ? randomUUID() : null;
    const command = commandForHerdrLaunch({
      repo: r.full_name,
      workflow: input.workflow,
      prNumber: input.prNumber,
      session: input.session,
      cwd: input.cwd,
      codingAgent: input.workflow === "issue-create" ? input.agent : undefined,
      model: input.workflow === "issue-create" ? input.model : undefined,
      env:
        issueCreateLaunchId != null
          ? { [ENV_ISSUE_CREATE_HERDR_LAUNCH]: issueCreateLaunchId }
          : undefined,
    });
    if (!command.trim()) throw new ServiceError(422, "command is required");

    const repo = { full_name: r.full_name, local_path: r.local_path };

    // Resume dedup (#578): if a pane in this repo's herdr session is already running
    // `claude --resume <session>` for this exact session, switch focus to it instead of piling
    // on another tab. Scoped to the "resume" workflow only — every other workflow (Build,
    // New Issue, github-pr-export) starts a fresh agent run each time by design. Best-effort:
    // any probe failure (herdr not running, nothing to find) falls through to the normal launch
    // below, same failure tolerance as sessions()/agentRead() above.
    if (input.workflow === "resume" && input.session) {
      const sessionName = herdrSessionName(repo);
      const existingPaneId = await findResumePaneId(sessionName, input.session);
      if (existingPaneId) {
        const focus = herdrAgentFocusArgv(repo, existingPaneId);
        try {
          await runHerdr(focus[0], focus.slice(1), r.local_path, {
            timeoutMs: 10_000,
          });
          return { backend: "herdr", focused: true, session_name: sessionName };
        } catch {
          // The pane found above can vanish (closed) or herdr can wedge between the probe and
          // this call — unlike the probe itself, this is the actual action, so a failure here
          // must not surface as a hard error for a Resume click that would otherwise have
          // succeeded via a fresh tab; fall through to the normal launch below (#578 review).
        }
      }
    }

    // New Issue and Scheduled Task creation get their own fresh workspaces instead of a tab in the
    // repo's existing default workspace (#544/#935) — neither has a PR worktree to pin to. The
    // worktree-backed workflows (Build/issue-dev, resume, github-pr-export) instead open a
    // workspace pinned to the PR's real worktree (#551, below). `herdr workspace create` seeds the
    // workspace with one tab and one empty pane in the same output shape `herdr tab create` uses,
    // so the tab/root-pane parsing below is unchanged either way.
    const isNewWorkspace =
      input.workflow === "issue-create" ||
      input.workflow === "scheduled-task-create";
    // Create a fresh tab (or workspace) first so the agent starts in it instead of splitting the
    // focused pane (#489). Best-effort: on any failure fall back to the tab-less launch (Herdr's
    // default split placement) rather than breaking the launch; a hard herdr failure still
    // surfaces from the agent start below. The timeout keeps a wedged herdr call from hanging
    // the RPC forever — runHerdr kills it and the catch falls back.
    let tabId: string | null = null;
    // The seed tab's root pane (from `worktree open`, its follow-up `tab create --workspace`, or
    // the plain repo-root `tab create`) is an empty default pane; `agent start --tab` below
    // splits alongside it instead of replacing it, leaving it behind (#503) unless the launch
    // closes it once the agent's own pane exists. Captured from the same output as tabId, so
    // it's only ever set together with a usable tabId.
    let rootPaneId: string | null = null;
    // Set whenever this launch is responsible for a whole *fresh* single-tab workspace — the
    // issue-create `workspace create` path, or a first-time worktree `worktree open` (#551,
    // acquireHerdrWorktreeTab's createdWorkspace) — used to close the whole workspace (not just
    // the tab) if the agent fails to start, since herdr refuses to close a workspace's last
    // remaining tab. Parsed independently from tabId out of the same response, so it is NOT
    // guaranteed to succeed/fail together with it — the cleanup below must handle either one
    // being null while the other is set. Not set when a worktree's workspace was merely *reused*
    // (acquireHerdrWorktreeTab's already-open branch) — that workspace predates this launch and
    // isn't this launch's to close.
    let workspaceId: string | null = null;
    let createdWorkspace = false;
    try {
      if (isNewWorkspace) {
        const create = herdrWorkspaceCreateArgv(repo);
        const out = await runHerdr(create[0], create.slice(1), r.local_path, {
          captureStdout: true,
          timeoutMs: 10_000,
        });
        tabId = parseHerdrTabId(out);
        rootPaneId = parseHerdrRootPaneId(out);
        workspaceId = parseHerdrWorkspaceId(out);
        createdWorkspace = true;
      } else {
        // Worktree-backed workflows (issue-dev/resume/github-pr-export, #551) open the herdr
        // workspace directly at the PR's real worktree path, so herdr's own workspace/worktree
        // metadata reflects it — instead of a plain repo-root tab the launched command cd's
        // into. Falls back to that plain tab below when there is no resolvable worktree path
        // or the worktree-open attempt itself fails for any reason.
        const worktreeTarget = await resolveHerdrWorktreeTarget(r, input);
        const acquired = worktreeTarget
          ? await acquireHerdrWorktreeTab(repo, r.local_path, worktreeTarget)
          : null;
        if (acquired) {
          tabId = acquired.tabId;
          rootPaneId = acquired.rootPaneId;
          workspaceId = acquired.workspaceId;
          createdWorkspace = acquired.createdWorkspace;
        } else {
          const tabCreate = herdrTabCreateArgv(repo);
          const out = await runHerdr(
            tabCreate[0],
            tabCreate.slice(1),
            r.local_path,
            {
              captureStdout: true,
              timeoutMs: 10_000,
            },
          );
          tabId = parseHerdrTabId(out);
          rootPaneId = parseHerdrRootPaneId(out);
        }
      }
      // Zero exit with no parseable id means a tab (or, when createdWorkspace, a whole workspace)
      // was likely created but can't be closed on failure (no id) — every such launch leaks one
      // empty tab or workspace. Log server-side (never to the client) so a herdr output-format
      // drift is noticed instead of silently leaking them.
      if (!tabId)
        console.error(
          `herdr ${createdWorkspace ? "workspace" : "tab"} create succeeded but its output had no usable tab id; falling back to split placement`,
        );
      else if (createdWorkspace && !workspaceId)
        console.error(
          "herdr workspace create succeeded but its output had no usable workspace id; failure cleanup may be unable to remove it",
        );
    } catch {
      tabId = null;
      rootPaneId = null;
      workspaceId = null;
    }
    // A workspace whose seeded tab id failed to parse can never be targeted — buildHerdrLaunchPlan
    // below only routes the agent into it via --tab — so it would otherwise sit orphaned forever
    // regardless of whether the agent-start call that follows succeeds or fails. Close it now
    // rather than relying on the failure-only cleanup further down. Applies whenever this launch
    // owns a freshly created workspace (workspaceId is only ever set in that case — see the
    // createdWorkspace comment above), not just the issue-create path.
    if (workspaceId && !tabId) {
      const cleanup = herdrWorkspaceCloseArgv(repo, workspaceId);
      runHerdrLaunch(cleanup[0], cleanup.slice(1), r.local_path).catch(
        () => {},
      );
      workspaceId = null;
      rootPaneId = null;
    }

    const plan = buildHerdrLaunchPlan({
      repo,
      command,
      label: input.label,
      tabId,
    });
    // Non-blocking: lh-web is a single process serving RPC for every client, so a
    // synchronous spawnSync here would stall the whole server for as long as the Herdr launch
    // takes (or hangs).
    try {
      const agentOut =
        issueCreateLaunchId != null
          ? await runHerdrLaunchCapture(
              plan.argv[0],
              plan.argv.slice(1),
              plan.cwd,
            )
          : await runHerdrLaunch(
              plan.argv[0],
              plan.argv.slice(1),
              plan.cwd,
            ).then(() => "");
      const agentPaneId = parseHerdrAgentPaneId(agentOut);
      if (issueCreateLaunchId != null && agentPaneId) {
        S.upsertIssueHerdrPane({
          launchId: issueCreateLaunchId,
          repoId: r.id,
          paneId: agentPaneId,
          sessionName: plan.sessionName,
        });
      }
    } catch (e) {
      // Don't leave the just-created empty tab (or workspace) behind; fire-and-forget cleanup.
      // herdr refuses to close a workspace's last remaining tab, so whenever a workspace was
      // created, close the whole workspace instead — even if tabId itself failed to parse (the
      // two ids come from independent parses of the same response, see the workspaceId comment
      // above, so either one can be set without the other).
      if (workspaceId) {
        const cleanup = herdrWorkspaceCloseArgv(repo, workspaceId);
        runHerdrLaunch(cleanup[0], cleanup.slice(1), r.local_path).catch(
          () => {},
        );
      } else if (tabId) {
        const cleanup = herdrTabCloseArgv(repo, tabId);
        runHerdrLaunch(cleanup[0], cleanup.slice(1), r.local_path).catch(
          () => {},
        );
      }
      // Attach the actual `herdr ...` invocation (not plan.command, which is only the inner
      // workflow command herdr would run) so the client can re-run the real command locally and
      // see the full output itself — this rides on top of the deliberately generic message (see
      // the comment on runHerdrLaunch above), so the client still never sees raw stdout/stderr/paths.
      //
      // Only suggest creating the session for the non-zero-exit case: that's the one empirically
      // confirmed to happen when the named session doesn't exist yet (`agent start` only works
      // against an already-running session, unlike the auto-creating bare `herdr --session` form).
      // ENOENT (herdr missing from PATH) or a signal-killed process have unrelated causes, and
      // suggesting `herdr --session <name>` there would just fail again the same way, misdirecting
      // the user away from the real fix.
      //
      // The suggested command is built from a tab-less plan: the failed argv's `--tab <id>`
      // points at the tab that was just cleaned up above, so re-running it verbatim would fail
      // with an unknown-tab error instead of reproducing the original failure.
      if (isServiceError(e))
        throw new ServiceError(e.status, e.message, {
          command: herdrCommandLine(
            buildHerdrLaunchPlan({ repo, command, label: input.label }),
          ),
          session: /^Herdr exited with status \d+$/.test(e.message)
            ? plan.sessionName
            : undefined,
        });
      throw e;
    }
    // Switch herdr's focus so the new agent's pane comes to the front now that it's running — the
    // create/open/tab-create calls above all used `--no-focus` so creation itself wouldn't yank
    // focus mid-launch, which otherwise leaves the just-launched terminal invisible until the user
    // switches to it by hand. Two selection modes:
    //   - A *fresh* workspace (createdWorkspace: New Issue's `workspace create`, or a worktree-backed
    //     launch's first-time `worktree open` #551) is selected by workspace id (#556) — its sole
    //     tab is the agent's.
    //   - Every other launch that got its own tab — a *reused* worktree workspace's freshly added
    //     tab, or the plain repo-root tab fallback — is selected by tab id (#625). `tab focus`
    //     switches workspace + tab in one call, so the new tab/pane is brought forward without
    //     re-selecting a workspace that already existed and isn't this launch's to refocus wholesale.
    // Only the tab-less fallback (tabId null: agent split into the already-focused pane) needs no
    // switch. Fire-and-forget, same as the pane close below: the agent is already running, so a
    // failure to switch focus must not fail the launch.
    if (createdWorkspace && workspaceId) {
      const focus = herdrWorkspaceFocusArgv(repo, workspaceId);
      runHerdrLaunch(focus[0], focus.slice(1), r.local_path).catch(() => {});
    } else if (tabId) {
      const focus = herdrTabFocusArgv(repo, tabId);
      runHerdrLaunch(focus[0], focus.slice(1), r.local_path).catch(() => {});
    }
    // The agent's own pane now exists alongside the tab's leftover empty root pane (see the
    // rootPaneId comment above) — close it. Fire-and-forget: the agent is already running, so a
    // failure here must not fail the launch, only leave one harmless empty pane behind.
    if (tabId && rootPaneId) {
      const paneClose = herdrPaneCloseArgv(repo, rootPaneId);
      runHerdrLaunch(paneClose[0], paneClose.slice(1), r.local_path).catch(
        () => {},
      );
    }
    return {
      backend: "herdr" as const,
      session_name: plan.sessionName,
      command: plan.command,
      cwd: plan.cwd,
      attach: `herdr session attach ${plan.sessionName}`,
    };
  },

  // Running herdr sessions grouped by repo, for terminal-aware UI surfaces (#495).
  // Read-only and deliberately failure-tolerant: herdr missing from PATH, no running
  // sessions, or unparseable output all degrade to an empty list — clients hide
  // the section instead of surfacing an error. Not gated on the configured launch
  // backend: sessions started outside LoopHub are just as real to a supervisor.
  sessions(): Promise<HerdrSessionsResult> {
    if (herdrSessionsInflight) return herdrSessionsInflight;
    herdrSessionsInflight = sweepHerdrSessions().finally(() => {
      herdrSessionsInflight = null;
    });
    return herdrSessionsInflight;
  },

  async cleanupClosedIssueNewIssueAgent(input: {
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
    return cleanupClosedIssueNewIssueAgentImpl(
      input.repo,
      Math.trunc(input.issueNumber),
    );
  },

  // Send Esc to `lh build` agents that have exceeded the top-level cost limit (#832). Worker-owned
  // maintenance, invoked by startCostStopSweep. Never kills; records `dev.cost_stopped` per stop.
  async enforceDevCostLimits(): Promise<{
    stopped: number;
    skipped: number;
    failed: number;
  }> {
    return enforceDevCostLimitsImpl();
  },

  // Kill `lh dev` agents whose PR has been closed/merged for at least one hour (#926). Reuses the
  // same Herdr pane-kill primitive as the manual kill button and is scheduled by the existing worker
  // agent-maintenance tick, not by a PR-specific timer.
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
  // in a worktree-linked workspace — which every single-tab `lh build --herdr` launch is, by
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
  // click action (#579). Reuses `herdr agent focus` (#578's herdrAgentFocusArgv), the same
  // one-call workspace+tab+pane focus the Resume dedup above already relies on. Like killAgent
  // above, a user-initiated action must fail visibly rather than degrade silently.
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
        "agent",
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

    const sendText = herdrPaneSendTextArgv(r, input.paneId, input.text);
    try {
      await runHerdr(sendText[0], sendText.slice(1), r.local_path, {
        timeoutMs: 10_000,
      });
    } catch {
      throw new ServiceError(
        409,
        "The Herdr agent disappeared before the input could be sent",
      );
    }
    const submit = herdrPaneSendKeysArgv(r, input.paneId, "Enter");
    try {
      await runHerdr(submit[0], submit.slice(1), r.local_path, {
        timeoutMs: 10_000,
      });
    } catch {
      throw new ServiceError(
        409,
        "The input was written, but Herdr could not submit it; check the pane before retrying",
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

// Finds the pane already running `claude --resume <session>` in a herdr session, if any (#578's
// Resume dedup — see the call site in terminal.launch above). Checks every agent's foreground
// process, not just its display name, since two Resume launches for different sessions can share
// one (see paneRunsClaudeResume's doc). Best-effort like sweepHerdrSessions below: any herdr
// failure (not running, no session yet, unparseable output) degrades to "nothing found" rather
// than blocking the launch this backs.
async function findResumePaneId(
  sessionName: string,
  session: string,
): Promise<string | null> {
  let agentsOut: string;
  try {
    agentsOut = await runHerdrCapture([
      "--session",
      sessionName,
      "agent",
      "list",
    ]);
  } catch {
    return null;
  }
  // HERDR_ID excludes the NO_PANE_ID_PREFIX control byte too, so this one check covers both "no
  // real pane to probe" and "pane_id isn't shaped like a real herdr id" — the latter matters
  // because, from here on, agent.id is spliced into further herdr argv (`pane process-info
  // --pane`, and the caller's `agent focus`), the same trust boundary killAgent's HERDR_ID check
  // guards for a client-supplied paneId (#578 review).
  const agents = parseHerdrAgentList(agentsOut).filter((a) =>
    HERDR_ID.test(a.id),
  );
  const hits = await Promise.all(
    agents.map(async (agent) => {
      try {
        const infoOut = await runHerdrCapture([
          "--session",
          sessionName,
          "pane",
          "process-info",
          "--pane",
          agent.id,
        ]);
        const processes = parseHerdrPaneProcessInfo(infoOut);
        return processes && paneRunsClaudeResume(processes, session)
          ? agent.id
          : null;
      } catch {
        return null;
      }
    }),
  );
  return hits.find((id): id is string => id !== null) ?? null;
}

async function sweepHerdrSessions(): Promise<HerdrSessionsResult> {
  let listOut: string;
  try {
    listOut = await runHerdrCapture(["session", "list", "--json"]);
  } catch {
    return { repos: [] };
  }
  const running = parseHerdrSessionListIfValid(listOut);
  if (running === null) return { repos: [] };
  if (running.length === 0) return { repos: [], running_repos: [] };

  const matched = reposWithRunningSession(S.listRepos("active"), running);
  const runningRepos = matched.map(({ repo }) => repo.full_name);
  const groups = await Promise.all(
    matched.map(async ({ repo, sessionName }) => {
      let agentsOut: string;
      try {
        // No `--json` here: `herdr agent list` rejects the flag and already prints JSON.
        agentsOut = await runHerdrCapture([
          "--session",
          sessionName,
          "agent",
          "list",
        ]);
      } catch {
        return null;
      }
      // Placements (not parseHerdrAgentList) so each agent carries the PR its cwd
      // resolves to — same id/name/status semantics, same `agent list` output (#611).
      const placements = parseHerdrAgentPlacements(
        agentsOut,
        worktreeRoot(),
        repo.full_name,
      );
      // A running session with zero agents has nothing to show — drop the group so
      // terminal-aware sections only appear when there is actual agent activity.
      if (placements.length === 0) return null;
      const issueCreatePaneIds = new Set(
        S.listIssueHerdrPanes(repo.id)
          .map((p) => p.pane_id)
          .filter((paneId): paneId is string => !!paneId),
      );
      const visiblePlacements = placements.filter(
        (agent) => !isIssueCreateAgent(agent, issueCreatePaneIds),
      );
      if (visiblePlacements.length === 0) return null;
      // One DB lookup per distinct PR number — several agents often share a worktree.
      const closedByPull = new Map<number, boolean>();
      const agents = visiblePlacements.map(({ id, name, status, pull }) => {
        let closed = false;
        if (pull !== null) {
          let known = closedByPull.get(pull);
          if (known === undefined) {
            const row = S.getIssue(repo.id, pull);
            // A pr-<n> dir with no matching PR row (or a same-numbered issue) resolves
            // to nothing — render normally rather than guessing staleness.
            known = !!row && row.kind === "pull" && row.state !== "open";
            closedByPull.set(pull, known);
          }
          closed = known;
        }
        return { id, name, status, pull, pull_closed: closed };
      });
      const pullWorkspaces = herdrPullWorkspacesFromAgentList(
        agentsOut,
        worktreeRoot(),
        repo.full_name,
      );
      // PR→issue for the pulls a workspace resolves to, so herdrIssueWorkspacesFromAgentList can
      // key the same panes by issue number (#821). The link is the PR's linked_issue_id, recorded
      // when `lh build` opened the PR (`Closes #<n>`); a PR with no linked issue is simply absent
      // from the map and skipped there, matching the parser's degrade-to-empty tolerance.
      const pullToIssue = new Map<number, number>();
      for (const w of pullWorkspaces) {
        const prRow = S.getIssue(repo.id, w.pull);
        if (prRow?.kind !== "pull") continue;
        const pull = S.getPull(prRow.id);
        if (pull?.linked_issue_id == null) continue;
        const linkedIssue = S.getIssueById(pull.linked_issue_id);
        if (linkedIssue) pullToIssue.set(w.pull, linkedIssue.number);
      }
      const issueWorkspaces = herdrIssueWorkspacesFromAgentList(
        agentsOut,
        worktreeRoot(),
        repo.full_name,
        pullToIssue,
      );
      return {
        repo: repo.full_name,
        session_name: sessionName,
        agents,
        pull_workspaces: pullWorkspaces,
        issue_workspaces: issueWorkspaces,
      };
    }),
  );
  return {
    repos: groups.filter((g) => g !== null),
    running_repos: runningRepos,
  };
}

// Terminates whatever a pane's foreground job is running by signaling it directly, instead of
// asking herdr to close the pane (see the killAgent comment above for why: `pane close` refuses
// with `confirmation_required` — "closing this pane would close a worktree group" — whenever the
// pane is the last one in a worktree-linked workspace, and there is no flag to force it, #805).
// Reads the pane's foreground process group id via `pane process-info` and SIGKILLs its
// negation, which kills the whole foreground job (an agent plus any children it spawned) without
// touching pane/tab/workspace state — so it can never hit that guard. When the pane is idle
// (nothing running but the shell), herdr reports the shell's own pid as the group leader, so the
// same call kills the shell too, same end result `pane close` used to give for a dead agent.
// POSIX-only: negative-pid process-group signaling matches herdr's own macOS/Linux-only support;
// this assumes lh-web itself also runs on a POSIX host.
async function killPaneForegroundProcess(
  repo: TerminalLaunchRepo,
  paneId: string,
  sessionName = herdrSessionName(repo),
): Promise<void> {
  let infoOut: string;
  try {
    infoOut = await runHerdr(
      "herdr",
      ["--session", sessionName, "pane", "process-info", "--pane", paneId],
      repo.local_path,
      { captureStdout: true, timeoutMs: 10_000 },
    );
  } catch (e) {
    throw isServiceError(e)
      ? e
      : new ServiceError(500, "failed to read pane process info");
  }
  // A small, accepted TOCTOU window: the OS could recycle this pid/pgid for an unrelated process
  // between this read and the signal below. Same trade-off any pid-based kill makes; the window
  // is short and there is no cheaper way to close it without herdr itself exposing an atomic
  // "kill the process behind this pane" call.
  const pid = parseHerdrPaneKillTarget(infoOut);
  if (pid == null)
    throw new ServiceError(
      500,
      "could not determine the process to kill for this pane",
    );
  try {
    process.kill(-pid, "SIGKILL");
  } catch (e) {
    // ESRCH: the process (and its whole group) is already gone — the agent is already dead,
    // exactly the outcome this call wants, so treat it as success rather than an error. Any other
    // errno (e.g. EPERM) is wrapped the same way as the two failure paths above, instead of
    // rethrown as a raw NodeJS.ErrnoException — this file's herdr/OS errors are deliberately
    // generic so a raw message never reaches the JSON-RPC client (see runHerdr's doc comment).
    if ((e as NodeJS.ErrnoException).code !== "ESRCH")
      throw new ServiceError(500, "failed to signal pane process");
  }
}

async function cleanupClosedIssueNewIssueAgentImpl(
  repoName: string,
  issueNumber: number,
): Promise<{ closed: number; skipped: number; failed: number }> {
  const repo = repoOr404(repoName);
  const issue = S.getIssue(repo.id, issueNumber);
  if (issue?.kind !== "issue" || issue.state !== "closed") {
    return { closed: 0, skipped: 1, failed: 0 };
  }
  const pane = S.getIssueHerdrPane(issue.id);
  if (!pane?.pane_id) return { closed: 0, skipped: 1, failed: 0 };
  if (!HERDR_ID.test(pane.pane_id)) return { closed: 0, skipped: 0, failed: 1 };

  const sessionName = pane.session_name ?? herdrSessionName(repo);
  try {
    await killPaneForegroundProcess(repo, pane.pane_id, sessionName);
  } catch {
    return { closed: 0, skipped: 0, failed: 1 };
  }
  runHerdr(
    "herdr",
    ["--session", sessionName, "pane", "close", pane.pane_id],
    repo.local_path,
    { timeoutMs: 10_000 },
  ).catch(() => {});
  return { closed: 1, skipped: 0, failed: 0 };
}

function closedPullAgentEligibleAt(
  prRow: S.IssueRow,
  pull: S.PullRow,
): string | null {
  if (pull.merged === 1) return pull.merged_at;
  if (prRow.state === "closed") return prRow.closed_at;
  return null;
}

function timestampPlus(value: string | null, ms: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed + ms;
}

async function cleanupClosedPullDevAgentsImpl(): Promise<{
  killed: number;
  skipped: number;
  failed: number;
}> {
  let listOut: string;
  try {
    listOut = await runHerdrCapture(["session", "list", "--json"]);
  } catch {
    return { killed: 0, skipped: 0, failed: 0 };
  }
  const running = parseHerdrSessionList(listOut);
  if (running.length === 0) return { killed: 0, skipped: 0, failed: 0 };

  const nowMs = Date.now();
  let killed = 0;
  let skipped = 0;
  let failed = 0;
  const matched = reposWithRunningSession(S.listRepos("active"), running);
  for (const { repo, sessionName } of matched) {
    let agentsOut: string;
    try {
      agentsOut = await runHerdrCapture([
        "--session",
        sessionName,
        "agent",
        "list",
      ]);
    } catch {
      continue;
    }
    const placements = parseHerdrAgentPlacements(
      agentsOut,
      worktreeRoot(),
      repo.full_name,
    );
    type Placement = (typeof placements)[number];
    const hasClosableWorkspace = (
      placement: Placement,
    ): placement is Placement & { workspaceId: string } =>
      HERDR_ID.test(placement.id) &&
      placement.workspaceId !== null &&
      HERDR_ID.test(placement.workspaceId);
    const byPull = new Map<number, (typeof placements)[number]>();
    for (const placement of placements) {
      if (placement.pull === null) continue;
      const current = byPull.get(placement.pull);
      if (
        current === undefined ||
        (!hasClosableWorkspace(current) && hasClosableWorkspace(placement))
      ) {
        byPull.set(placement.pull, placement);
      }
    }
    for (const [pullNumber, pane] of byPull) {
      const prRow = S.getIssue(repo.id, pullNumber);
      if (prRow?.kind !== "pull") {
        skipped++;
        continue;
      }
      const pull = S.getPull(prRow.id);
      if (!pull) {
        skipped++;
        continue;
      }
      const eligibleAt = timestampPlus(
        closedPullAgentEligibleAt(prRow, pull),
        CLOSED_PULL_AGENT_GRACE_MS,
      );
      if (eligibleAt === null || nowMs < eligibleAt) {
        skipped++;
        continue;
      }
      const sessionId = S.primaryDevSessionForPull(prRow.id);
      if (sessionId === null) {
        skipped++;
        continue;
      }
      if (!hasClosableWorkspace(pane)) {
        failed++;
        continue;
      }
      const close = herdrWorkspaceCloseArgv(repo, pane.workspaceId);
      try {
        await runHerdr(close[0], close.slice(1), repo.local_path, {
          timeoutMs: 10_000,
        });
      } catch {
        failed++;
        continue;
      }
      S.emitEvent(repo.id, CLOSED_PULL_AGENT_KILLED_EVENT, "lh-worker", {
        number: pullNumber,
        pr: pullNumber,
        session_id: sessionId,
        pane_id: pane.id,
        reason: CLOSED_PULL_AGENT_KILL_REASON,
      });
      killed++;
    }
  }
  return { killed, skipped, failed };
}

// herdr key name sent to a pane to interrupt (cancel the current turn of) a running claude/codex
// agent (#832). Kept as a single literal so §Test can adjust it to herdr's actual Esc key name in
// one place. Never derived from process output — sent verbatim to `pane send-keys`.
const COST_STOP_KEY = "Escape";

// Stop `lh build` implementation agents whose top-level cumulative cost has passed the limit (#832),
// by sending Esc to their herdr pane — no kill. It enumerates running herdr sessions → active repos
// → each pane the `agent list` resolves to a `pr-<n>` worktree. For each such pane we resolve the
// PR's primary dev session, read its top-level cost, and let decideCostStop judge. A pane that
// doesn't map to an open PR with a linked dev session is left alone (so unrelated terminals are
// never stopped); ambiguous cost (unknown/no session) is a retryable no-op, not a stop. A stop emits
// `dev.cost_stopped`, which both records the reason and guards against re-sending Esc on later ticks.
async function enforceDevCostLimitsImpl(): Promise<{
  stopped: number;
  skipped: number;
  failed: number;
}> {
  let listOut: string;
  try {
    listOut = await runHerdrCapture(["session", "list", "--json"]);
  } catch {
    return { stopped: 0, skipped: 0, failed: 0 };
  }
  const running = parseHerdrSessionList(listOut);
  if (running.length === 0) return { stopped: 0, skipped: 0, failed: 0 };

  const limitUsd = devCostLimitUsd();
  let stopped = 0;
  let skipped = 0;
  let failed = 0;
  const matched = reposWithRunningSession(S.listRepos("active"), running);
  for (const { repo, sessionName } of matched) {
    let agentsOut: string;
    try {
      agentsOut = await runHerdrCapture([
        "--session",
        sessionName,
        "agent",
        "list",
      ]);
    } catch {
      continue;
    }
    for (const pane of herdrPullWorkspacesFromAgentList(
      agentsOut,
      worktreeRoot(),
      repo.full_name,
    )) {
      // Only a pane whose cwd resolves to an open PR row is a candidate — an unrelated terminal
      // (or a pane on a closed/merged PR) has no such mapping and is never touched (AC5).
      const prRow = S.getIssue(repo.id, pane.pull);
      if (prRow?.kind !== "pull" || prRow.state !== "open") {
        skipped++;
        continue;
      }
      const sessionId = S.primaryDevSessionForPull(prRow.id);
      const costUsd = sessionId
        ? S.sessionUsageCostForSession(sessionId)
        : null;
      const decision = decideCostStop({
        costUsd,
        limitUsd,
        // Guard per dev session (not per PR): without a session there is nothing to have stopped.
        alreadyStopped:
          sessionId !== null &&
          S.hasCostStopEvent(repo.id, pane.pull, sessionId),
        hasDevSession: sessionId !== null,
      });
      if (decision.action !== "stop") {
        skipped++;
        continue;
      }
      // Guard the herdr-supplied pane id before it reaches an argv, same trust boundary as killAgent.
      if (!HERDR_ID.test(pane.pane_id)) {
        failed++;
        continue;
      }
      try {
        const argv = herdrPaneSendKeysArgv(repo, pane.pane_id, COST_STOP_KEY);
        await runHerdr(argv[0], argv.slice(1), repo.local_path, {
          timeoutMs: 10_000,
        });
      } catch {
        // Couldn't deliver the keystroke (herdr gone, pane vanished): don't record a stop, so the
        // next sweep retries — the ambiguous-live-state → retryable rule (AC6).
        failed++;
        continue;
      }
      // Persist the stop reason: a human can see from the event log why the agent stopped, and the
      // next tick's hasCostStopEvent guard skips this session (no repeated Esc for the same dev
      // session; a later resumed session is guarded independently).
      S.emitEvent(repo.id, DEV_COST_STOPPED_EVENT, "lh-worker", {
        number: pane.pull,
        pr: pane.pull,
        session_id: sessionId,
        reason: COST_STOP_REASON,
        cost_usd: decision.costUsd,
        limit_usd: limitUsd,
      });
      stopped++;
    }
  }
  return { stopped, skipped, failed };
}
