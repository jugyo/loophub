import { spawnSync } from "node:child_process";
import {
  acquireHerdrWorktreeTab,
  buildHerdrLaunchPlan,
  type HerdrCmdRunner,
  herdrCommandLine,
  herdrPaneCloseArgv,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrWorkspaceCloseArgv,
  normalizeAgentName,
  parseHerdrAgentPaneId,
  parseHerdrRootPaneId,
  parseHerdrTabId,
  type TerminalLaunchRepo,
} from "../core/terminal/terminal-launch.ts";

// Raised by launchAgentInWorktreeHerdr instead of calling the CLI's fail()/process.exit directly,
// so the helper stays free of cli/context.ts and each caller renders the message and chooses its own
// exit (Build always exits; Workflow exits when detached but attaches when interactive).
export class HerdrLaunchError extends Error {}

export interface HerdrLaunchResult {
  // The repo-derived herdr session name every launch for this repo lands in.
  sessionName: string;
  // The normalized agent name the command runs under (the label after normalizeAgentName).
  agentName: string;
  // The exact pane created by `herdr agent start`, used to persist a durable pane/session link.
  paneId: string | null;
}

// Opens (or reuses) the target worktree's own herdr workspace and starts `command` in a fresh tab
// there, instead of splitting whatever pane is currently focused (#674, #873) — the same
// orchestration `lh build --herdr` used inline. Both `lh build --herdr` and `lh workflow start
// --herdr` call this so a Workflow parent lands in the same worktree workspace a normal Build would.
// A first-time `worktree open` creates a brand-new single-tab workspace; a reused one gets a fresh
// tab; and when the worktree open can't be resolved (herdr not running, worktree_not_found, …) it
// falls back to a plain repo-root tab (still a new tab, not a split). On any failure to start the
// agent it cleans up the tab/workspace it created and throws HerdrLaunchError with a reproduce hint;
// the user-facing agent start focuses its placement atomically, then the leftover seed pane closes.
export async function launchAgentInWorktreeHerdr(input: {
  repo: TerminalLaunchRepo;
  worktree: string;
  command: string;
  label: string;
}): Promise<HerdrLaunchResult> {
  const { repo, worktree, command, label } = input;
  // Best-effort herdr runner for the ancillary tab/workspace calls (open, create, focus, close).
  // spawnSync suits this short-lived CLI process (unlike lh-web, whose single server process spawns
  // herdr async); all-ignore stdio keeps herdr's own JSON/errors out of the launch output, and it
  // never throws — a failed call resolves ok:false so acquireHerdrWorktreeTab / the fallback simply
  // degrade.
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
  let tabId: string | null = null;
  let rootPaneId: string | null = null;
  // The fresh single-tab workspace this launch *owns* (cleanup target on failure) — set only when
  // acquireHerdrWorktreeTab created one, null for a reused workspace.
  let workspaceId: string | null = null;
  // The target worktree's workspace, used as the `--workspace` placement fallback when tabId came
  // back null (#873). Set whether the workspace was freshly opened or reused; only ever absent on
  // the plain repo-root tab-create fallback below (which has no worktree workspace at all).
  let placementWorkspaceId: string | null = null;
  const acquired = await acquireHerdrWorktreeTab(repo, worktree, runHerdrCmd);
  if (acquired) {
    ({ tabId, rootPaneId, workspaceId } = acquired);
    placementWorkspaceId = acquired.targetWorkspaceId;
  } else {
    const out = await runHerdrCmd(herdrTabCreateArgv(repo), {
      captureStdout: true,
    });
    if (out.ok) {
      tabId = parseHerdrTabId(out.stdout);
      rootPaneId = parseHerdrRootPaneId(out.stdout);
      // A zero-exit create with no parseable tab id means herdr made a real tab but its output shape
      // drifted: tabId stays null, and with no worktree workspace to fall back to (this is the plain
      // repo-root path) the agent splits the focused pane and the new tab is orphaned with no id to
      // close it. Surface it (mirrors launchIssueDevHerdr's server-side warning) so the drift is
      // noticed instead of leaking silently.
      if (!tabId)
        console.error(
          "herdr tab create succeeded but its output had no usable tab id; falling back to split placement",
        );
    }
  }
  // The pane is pinned to the worktree (not repo.local_path) but keeps the repo's herdr session
  // name, so it lands alongside every other launch for this repo. When tabId failed to parse but the
  // worktree's workspace was opened/reused, `--workspace placementWorkspaceId` keeps the agent inside
  // that workspace instead of splitting whatever (possibly unrelated) pane is focused (#873).
  const plan = buildHerdrLaunchPlan({
    repo,
    command,
    label,
    tabId,
    workspaceId: placementWorkspaceId,
    cwd: worktree,
    // Keep focus in the same Herdr operation that starts the agent. A separate post-start focus can
    // race with a newly live Workflow parent launching its Execute child and steal focus then.
    focus: true,
  });
  const herdrProc = spawnSync(plan.argv[0], plan.argv.slice(1), {
    stdio: ["inherit", "pipe", "inherit"],
    timeout: 15_000,
    encoding: "utf8",
  });
  const herdrStdout = herdrProc.stdout ?? "";
  if (herdrStdout) process.stdout.write(herdrStdout);
  // Any failure to start the agent leaves the just-created tab (or workspace) empty — clean it up
  // before failing. herdr refuses to close a workspace's last tab, so a workspace this launch
  // created is closed wholesale. The reproduce hint is built from a *tab-less* plan: the failed
  // argv's `--tab <id>` points at the tab just cleaned up, so re-running it verbatim would fail with
  // an unknown-tab error instead of reproducing the original failure.
  const cleanupOnFailure = async () => {
    if (workspaceId)
      await runHerdrCmd(herdrWorkspaceCloseArgv(repo, workspaceId));
    else if (tabId) await runHerdrCmd(herdrTabCloseArgv(repo, tabId));
  };
  const reproduce = () =>
    herdrCommandLine(
      buildHerdrLaunchPlan({
        repo,
        command,
        label,
        cwd: worktree,
        focus: true,
      }),
    );
  if (herdrProc.error) {
    const err = herdrProc.error as NodeJS.ErrnoException;
    await cleanupOnFailure();
    if (err.code === "ENOENT") {
      throw new HerdrLaunchError(
        "failed to launch herdr: 'herdr' not found on PATH",
      );
    }
    throw new HerdrLaunchError(`failed to launch herdr: ${err.message}`);
  }
  // spawnSync's own `timeout` kills the child via signal without populating `.error`, so `status`
  // comes back `null` on both a timeout and an external kill — checking status alone would silently
  // report either as success.
  if (herdrProc.signal) {
    await cleanupOnFailure();
    throw new HerdrLaunchError(
      `herdr was terminated by signal ${herdrProc.signal} (killed, or timed out after 15s)\n  reproduce: ${reproduce()}`,
    );
  }
  if ((herdrProc.status ?? 0) !== 0) {
    await cleanupOnFailure();
    throw new HerdrLaunchError(
      `herdr exited with status ${herdrProc.status}\n  reproduce: ${reproduce()}`,
    );
  }
  // Creation above stays --no-focus so an incomplete launch never becomes visible. Once agent
  // start succeeds, its atomic --focus has already brought the final pane forward. Closing the
  // leftover seed pane is still best-effort cleanup and does not change the selected agent pane.
  if (tabId && rootPaneId) {
    await runHerdrCmd(herdrPaneCloseArgv(repo, rootPaneId));
  }
  return {
    sessionName: plan.sessionName,
    agentName: normalizeAgentName(label),
    paneId: parseHerdrAgentPaneId(herdrStdout),
  };
}
