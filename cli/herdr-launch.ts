import { spawnSync } from "node:child_process";
import {
  isHerdrExitError,
  startHerdrSession,
} from "../core/service/herdr-runner.ts";
import { parseHerdrSessionListIfValid } from "../core/terminal/herdr-status.ts";
import {
  acquireHerdrWorktreeWorkspace,
  buildHerdrLaunchPlan,
  executeHerdrLaunchPlan,
  type HerdrCmdRunner,
  type HerdrLaunchRunner,
  herdrCommandLine,
  herdrSessionName,
  herdrTabCloseArgv,
  herdrWorkspaceCloseArgv,
  type TerminalLaunchRepo,
} from "../core/terminal/terminal-launch.ts";

// Raised by launchAgentInWorktreeHerdr instead of calling the CLI's fail()/process.exit directly,
// so the helper stays free of cli/context.ts and each caller renders the message and chooses its own
// exit (Build always exits; Workflow exits when detached but attaches when interactive).
export class HerdrLaunchError extends Error {}

const HERDR_LAUNCH_FAILURE = {
  pane: "create the agent's pane",
  agent: "start the agent",
} as const;

export interface HerdrLaunchResult {
  // The repo-derived herdr session name every launch for this repo lands in.
  sessionName: string;
  // The exact pane the agent runs in, used to persist a durable pane/session link.
  paneId: string | null;
  // The tab that pane lives in, for a caller that wants to bring the launch forward. Null when the
  // placement produced no parseable tab id.
  tabId: string | null;
}

// Workflow parents always launch into a herdr session, but the session may not be running yet — a
// cold machine, or Web's Start workflow spawning `lh workflow start --herdr` on a host that has
// never opened one. The launch calls below would then all fail against a missing session, so start
// its server headless first via the same core helper the New Issue flow uses (#50). A session that
// is already running is reused untouched; only a genuinely absent one triggers a start. Failures to
// determine or establish the session stay visible (they must not degrade into a confusing
// "could not create the agent's pane" later), so this throws HerdrLaunchError on every failure path.
async function ensureHerdrSessionRunning(
  repo: TerminalLaunchRepo,
  runHerdrCmd: HerdrCmdRunner,
): Promise<void> {
  const sessionName = herdrSessionName(repo);
  const listed = await runHerdrCmd(["herdr", "session", "list", "--json"], {
    captureStdout: true,
  });
  if (!listed.ok) {
    throw new HerdrLaunchError("herdr failed to list running sessions");
  }
  const running = parseHerdrSessionListIfValid(listed.stdout);
  if (running === null) {
    throw new HerdrLaunchError(
      "herdr session list returned an invalid response",
    );
  }
  if (running.includes(sessionName)) return;
  try {
    await startHerdrSession(sessionName, repo.local_path);
  } catch (error) {
    const detail = isHerdrExitError(error)
      ? `: herdr exited with status ${error.exitStatus}`
      : error instanceof Error
        ? `: ${error.message}`
        : "";
    throw new HerdrLaunchError(
      `failed to start headless herdr session ${sessionName}${detail}`,
    );
  }
}

// Opens (or reuses) the target worktree's own herdr workspace and starts the agent in a fresh tab
// there, instead of splitting whatever pane is currently focused (#674, #873). `lh workflow start
// --herdr` calls this so a Workflow parent lands in the target worktree's own workspace. When the
// session is not running it is started headless first via ensureHerdrSessionRunning (#50); when the
// worktree open can't be resolved (herdr not running, worktree_not_found, …) it falls back
// to a plain repo-root tab. On any failure to start the agent it cleans up the tab/workspace it
// created and throws HerdrLaunchError with a reproduce hint.
export async function launchAgentInWorktreeHerdr(input: {
  repo: TerminalLaunchRepo;
  worktree: string;
  // Environment the agent must see. Applied when the pane is created — the command is typed into
  // that pane's shell and inherits nothing else.
  env?: Record<string, string>;
  // The command the launch types into its pane, prompt included (see agentCommandLine).
  command: string;
  label: string;
}): Promise<HerdrLaunchResult> {
  const { repo, worktree, label } = input;
  // Best-effort herdr runner for the ancillary workspace calls (open and close). spawnSync suits
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
  // The launch steps themselves also need stderr, which is where herdr reports the error code a
  // failed step is diagnosed from.
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

  // The worktree-open and every launch step below run over the repo session's socket, so that
  // session must be live first. When it is not, start its server headless before anything else.
  await ensureHerdrSessionRunning(repo, runHerdrCmd);

  const acquired = await acquireHerdrWorktreeWorkspace(
    repo,
    worktree,
    runHerdrCmd,
  );
  const plan = buildHerdrLaunchPlan({
    repo,
    command: input.command,
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

  // The open seeded a newly created workspace with an empty tab that the launch could not use
  // (`worktree open` takes no `--env`), so drop it once the real tab exists. Creation and launch
  // stay `--no-focus` so a half-built placement never steals the operator's view; the caller
  // focuses the completed agent pane after this returns.
  if (acquired?.createdWorkspace) {
    if (acquired.seedTabId)
      await runHerdrCmd(herdrTabCloseArgv(repo, acquired.seedTabId));
  }
  return {
    sessionName: plan.sessionName,
    paneId: outcome.paneId,
    tabId: outcome.tabId,
  };
}
