import { worktreeRoot } from "../config.ts";
import { ServiceError } from "../errors.ts";
import {
  herdrPullWorkspacesFromAgentList,
  parseHerdrAgentPlacements,
  parseHerdrSessionList,
  parseHerdrTabList,
  parseHerdrWorkspaceList,
} from "../terminal/herdr-status.ts";
import {
  herdrAgentFocusArgv,
  herdrSessionName,
} from "../terminal/terminal-launch.ts";
import { runHerdr, runHerdrCapture } from "./herdr-runner.ts";
import { repoOr404 } from "./shared.ts";

export interface HerdrTreeAgent {
  id: string;
  name: string;
  status: string;
  pull: number | null;
}

export interface HerdrTreeTab {
  id: string;
  number: number;
  agents: HerdrTreeAgent[];
}

export interface HerdrTreeWorkspace {
  id: string;
  label: string;
  number: number;
  tabs: HerdrTreeTab[];
}

// Investigation tool for the "Build button opens the wrong workspace" suspicion (#602): a
// hierarchical workspace -> tab -> agent(PR) view of a repo's herdr session, backing `lh herdr`.
// Unlike terminal.sessions() (the sidebar's per-agent flat list), this also enumerates empty
// workspaces/tabs so a human can see the *whole* session shape, not just where agents happen to
// be running. `running: false` (session not started yet) is a normal, non-error result — same
// degrade-to-empty tolerance as sweepHerdrSessions — so the CLI can show a plain message instead
// of a stack trace.
export const herdr = {
  async tree(input: { repo: string }): Promise<{
    session_name: string;
    running: boolean;
    workspaces: HerdrTreeWorkspace[];
  }> {
    const r = repoOr404(input.repo);
    const sessionName = herdrSessionName(r);
    let listOut: string;
    try {
      listOut = await runHerdrCapture(["session", "list", "--json"]);
    } catch {
      return { session_name: sessionName, running: false, workspaces: [] };
    }
    if (!parseHerdrSessionList(listOut).includes(sessionName)) {
      return { session_name: sessionName, running: false, workspaces: [] };
    }
    let workspacesOut: string;
    let tabsOut: string;
    let agentsOut: string;
    try {
      [workspacesOut, tabsOut, agentsOut] = await Promise.all([
        runHerdrCapture(["--session", sessionName, "workspace", "list"]),
        runHerdrCapture(["--session", sessionName, "tab", "list"]),
        runHerdrCapture(["--session", sessionName, "agent", "list"]),
      ]);
    } catch {
      // The session was confirmed running above, but died or errored on one of the follow-up
      // calls (transient hiccup, race with the session shutting down mid-request) — degrade to
      // the same "not running" result rather than letting a raw ServiceError (e.g. "Herdr
      // exited with status 1") reach the CLI, matching sweepHerdrSessions's tolerance for a
      // post-session-list-check failure.
      return { session_name: sessionName, running: false, workspaces: [] };
    }
    const workspaces = parseHerdrWorkspaceList(workspacesOut);
    const tabs = parseHerdrTabList(tabsOut);
    const agents = parseHerdrAgentPlacements(
      agentsOut,
      worktreeRoot(),
      r.full_name,
    );
    return {
      session_name: sessionName,
      running: true,
      workspaces: workspaces.map((w) => ({
        id: w.id,
        label: w.label,
        number: w.number,
        tabs: tabs
          .filter((t) => t.workspaceId === w.id)
          .map((t) => ({
            id: t.id,
            number: t.number,
            agents: agents
              .filter((a) => a.tabId === t.id)
              .map((a) => ({
                id: a.id,
                name: a.name,
                status: a.status,
                pull: a.pull,
              })),
          })),
      })),
    };
  },

  // Focuses the pane of the running agent whose worktree belongs to PR `pull` (#602's
  // `lh herdr focus <pr>`) — reuses the same PR->pane_id resolution the issue-list badge relies
  // on (herdrPullWorkspacesFromAgentList), then herdrAgentFocusArgv to switch to it. A
  // user-initiated action, so it fails visibly (ServiceError) rather than degrading silently,
  // same as terminal.focusAgent.
  async focus(input: { repo: string; pull: number }): Promise<{
    ok: true;
    pane_id: string;
  }> {
    const r = repoOr404(input.repo);
    const sessionName = herdrSessionName(r);
    let listOut: string;
    try {
      listOut = await runHerdrCapture(["session", "list", "--json"]);
    } catch {
      throw new ServiceError(
        422,
        `herdr session "${sessionName}" is not running`,
      );
    }
    if (!parseHerdrSessionList(listOut).includes(sessionName)) {
      throw new ServiceError(
        422,
        `herdr session "${sessionName}" is not running`,
      );
    }
    let agentsOut: string;
    try {
      agentsOut = await runHerdrCapture([
        "--session",
        sessionName,
        "agent",
        "list",
      ]);
    } catch {
      // Same race as tree() above: the session was confirmed running by the check above but
      // died or errored on this follow-up call — report it the same way as "never running" so
      // the caller doesn't see a message that depends on the race's exact timing.
      throw new ServiceError(
        422,
        `herdr session "${sessionName}" is not running`,
      );
    }
    const match = herdrPullWorkspacesFromAgentList(
      agentsOut,
      worktreeRoot(),
      r.full_name,
    ).find((w) => w.pull === input.pull);
    if (!match)
      throw new ServiceError(
        404,
        `No running agent found for PR #${input.pull} in herdr session "${sessionName}"`,
      );
    const argv = herdrAgentFocusArgv(r, match.pane_id);
    await runHerdr(argv[0], argv.slice(1), r.local_path, {
      timeoutMs: 10_000,
    });
    return { ok: true, pane_id: match.pane_id };
  },
};
