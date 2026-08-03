import { spawnSync } from "node:child_process";
import type { RuntimeBin } from "../core/runtimes.ts";
import {
  acquireHerdrWorktreeWorkspace,
  buildHerdrLaunchPlan,
  executeHerdrLaunchPlan,
  type HerdrCmdRunner,
  type HerdrLaunchRunner,
  herdrCommandLine,
  herdrTabCloseArgv,
  herdrTabFocusArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceFocusArgv,
  type TerminalLaunchRepo,
} from "../core/terminal/terminal-launch.ts";

// Raised by launchAgentInWorktreeHerdr instead of calling the CLI's fail()/process.exit directly,
// so the helper stays free of cli/context.ts and each caller renders the message and chooses its own
// exit (Build always exits; Workflow exits when detached but attaches when interactive).
export class HerdrLaunchError extends Error {}

const HERDR_LAUNCH_FAILURE = {
  pane: "create the agent's pane",
  agent: "start the agent",
  prompt: "deliver the agent's prompt",
} as const;

export interface HerdrLaunchResult {
  // The repo-derived herdr session name every launch for this repo lands in.
  sessionName: string;
  // The herdr agent name the launch registered (a slug — see herdrAgentSlug), usable as an
  // `agent attach` / `agent focus` target.
  agentName: string;
  // The exact pane the agent runs in, used to persist a durable pane/session link.
  paneId: string | null;
}

// Opens (or reuses) the target worktree's own herdr workspace and starts the agent in a fresh tab
// there, instead of splitting whatever pane is currently focused (#674, #873). `lh workflow start
// --herdr` calls this so a Workflow parent lands in the target worktree's own workspace.
// When the worktree open can't be resolved (herdr not running, worktree_not_found, …) it falls back
// to a plain repo-root tab. On any failure to start the agent it cleans up the tab/workspace it
// created and throws HerdrLaunchError with a reproduce hint.
export async function launchAgentInWorktreeHerdr(input: {
  repo: TerminalLaunchRepo;
  worktree: string;
  // The runtime binary, the newline-free flags it is started with, and the prompt delivered into
  // the running agent afterwards — herdr 0.7.5's `agent start` rejects any argument containing a
  // newline, so the (multi-KB, newline-bearing) prompt cannot ride on the command line.
  program: { bin: RuntimeBin; args: string[]; prompt?: string };
  // Environment the agent must see. Applied when the pane is created — `agent start` execs the
  // runtime binary directly and carries no environment of its own.
  env?: Record<string, string>;
  // Human-readable rendering of the launch, for messages only.
  command: string;
  label: string;
}): Promise<HerdrLaunchResult> {
  const { repo, worktree, label } = input;
  // Best-effort herdr runner for the ancillary workspace calls (open, focus, close). spawnSync suits
  // this short-lived CLI process (unlike lh-web, whose single server process spawns herdr async);
  // it never throws — a failed call resolves ok:false so the caller simply degrades.
  const runHerdrCmd: HerdrCmdRunner = async (argv, opts) => {
    const proc = spawnSync(argv[0], argv.slice(1), {
      stdio: opts?.captureStdout ? ["ignore", "pipe", "ignore"] : "ignore",
      timeout: 15_000,
      encoding: "utf8",
    });
    const ok = !proc.error && proc.signal == null && (proc.status ?? 0) === 0;
    return {
      stdout: ok && opts?.captureStdout ? (proc.stdout ?? "") : "",
      ok,
    };
  };
  // The launch steps themselves also need stderr, which is where herdr reports its error codes —
  // executeHerdrLaunchPlan waits out `agent_pane_busy` and fails on anything else.
  const runLaunchStep: HerdrLaunchRunner = async (argv) => {
    const proc = spawnSync(argv[0], argv.slice(1), {
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 30_000,
      encoding: "utf8",
    });
    return {
      stdout: proc.stdout ?? "",
      stderr: proc.error ? proc.error.message : (proc.stderr ?? ""),
      ok: !proc.error && proc.signal == null && (proc.status ?? 0) === 0,
    };
  };

  const acquired = await acquireHerdrWorktreeWorkspace(
    repo,
    worktree,
    runHerdrCmd,
  );
  const plan = buildHerdrLaunchPlan({
    repo,
    command: input.command,
    program: input.program,
    env: input.env,
    label,
    // The pane is pinned to the worktree (not repo.local_path) but keeps the repo's herdr session
    // name, so it lands alongside every other launch for this repo.
    workspaceId: acquired?.workspaceId,
    cwd: worktree,
  });
  const outcome = await executeHerdrLaunchPlan(plan, runLaunchStep);
  if (outcome.stdout) process.stdout.write(outcome.stdout);

  if (!outcome.ok) {
    // Don't leave the tab (or workspace) this launch created behind. herdr refuses to close a
    // workspace's last tab, so a workspace this launch opened is closed wholesale.
    if (acquired?.createdWorkspace)
      await runHerdrCmd(herdrWorkspaceCloseArgv(repo, acquired.workspaceId));
    else if (outcome.tabId)
      await runHerdrCmd(herdrTabCloseArgv(repo, outcome.tabId));
    const detail = outcome.stderr.trim();
    throw new HerdrLaunchError(
      `herdr failed to ${HERDR_LAUNCH_FAILURE[outcome.failed ?? "agent"]}${
        detail ? `: ${detail}` : ""
      }\n  reproduce: ${herdrCommandLine(plan)}`,
    );
  }

  // Creation stays --no-focus so an incomplete launch never becomes visible; bring the finished one
  // forward now. A workspace this launch opened is selected wholesale (#556); a reused workspace's
  // freshly added tab is selected by tab id so a workspace that isn't ours isn't refocused (#625).
  // Fire-and-forget: the agent is already running, so a focus failure must not fail the launch.
  if (acquired?.createdWorkspace) {
    // The open seeded the workspace with an empty tab that the launch could not use (`worktree
    // open` takes no `--env`), so it is dropped once the real tab exists.
    if (acquired.seedTabId)
      await runHerdrCmd(herdrTabCloseArgv(repo, acquired.seedTabId));
    await runHerdrCmd(herdrWorkspaceFocusArgv(repo, acquired.workspaceId));
  } else if (outcome.tabId) {
    await runHerdrCmd(herdrTabFocusArgv(repo, outcome.tabId));
  }
  return {
    sessionName: plan.sessionName,
    agentName: plan.agentName,
    paneId: outcome.paneId,
  };
}
