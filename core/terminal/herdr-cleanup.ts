import type { HerdrSessionsWire } from "../serialize.ts";
import { runHerdr, runHerdrCapture } from "../service/herdr-runner.ts";
import type { TerminalLaunchRepo } from "../service/shared.ts";
import {
  HERDR_ID,
  herdrSessionName,
  herdrWorkspaceCloseArgv,
  isServiceError,
  parseHerdrAgentPlacements,
  parseHerdrPaneKillTarget,
  parseHerdrSessionList,
  parseHerdrSessionListIfValid,
  repoOr404,
  reposWithRunningSession,
  S,
  ServiceError,
  worktreeRoot,
} from "../service/shared.ts";
import { projectHerdrRepoSessions } from "./session-projection.ts";

const CLOSED_PULL_AGENT_GRACE_MS = 60 * 60 * 1000;
const CLOSED_PULL_AGENT_KILLED_EVENT = "agent_session.killed";
const CLOSED_PULL_AGENT_KILL_REASON = "pr_closed_grace_elapsed";

export async function sweepHerdrSessions(): Promise<HerdrSessionsWire> {
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
      return projectHerdrRepoSessions(
        repo,
        sessionName,
        agentsOut,
        worktreeRoot(),
      );
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
export async function killPaneForegroundProcess(
  repo: TerminalLaunchRepo,
  paneId: string,
  sessionName = herdrSessionName(repo),
  stillEligible?: () => boolean,
): Promise<boolean> {
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
  if (stillEligible && !stillEligible()) return false;
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
  return true;
}

export async function closeManagedHerdrPaneIfUnclaimed(
  repo: S.Repo,
  paneId: number,
): Promise<"closed" | "skipped" | "failed"> {
  let pane = S.getHerdrPaneCloseCandidate(paneId);
  if (!pane) return "skipped";
  if (!pane.pane_id || !HERDR_ID.test(pane.pane_id)) return "failed";

  const sessionName = pane.session_name ?? herdrSessionName(repo);
  try {
    const killed = await killPaneForegroundProcess(
      repo,
      pane.pane_id,
      sessionName,
      () => S.getHerdrPaneCloseCandidate(paneId) != null,
    );
    if (!killed) return "skipped";
    pane = S.getHerdrPaneCloseCandidate(paneId);
    if (!pane?.pane_id) return "skipped";
    await runHerdr(
      "herdr",
      ["--session", sessionName, "pane", "close", pane.pane_id],
      repo.local_path,
      { timeoutMs: 10_000 },
    );
    S.markHerdrPaneClosed(pane.id);
    return "closed";
  } catch {
    return "failed";
  }
}

export async function cleanupClosedIssuePanesImpl(
  repoName: string,
  issueNumber: number,
): Promise<{ closed: number; skipped: number; failed: number }> {
  const repo = repoOr404(repoName);
  const issue = S.getIssue(repo.id, issueNumber);
  if (issue?.kind !== "issue" || issue.state !== "closed") {
    return { closed: 0, skipped: 1, failed: 0 };
  }
  const release = S.releaseHerdrPaneClaimsForResource({
    repoId: repo.id,
    resourceKind: "issue",
    resourceKey: String(issue.id),
  });
  if (release.closeCandidates.length === 0) {
    return { closed: 0, skipped: 1, failed: 0 };
  }

  let closed = 0;
  let failed = 0;
  for (const pane of release.closeCandidates) {
    const cleanup = await closeManagedHerdrPaneIfUnclaimed(repo, pane.id);
    if (cleanup === "closed") closed += 1;
    else if (cleanup === "failed") failed += 1;
  }
  return {
    closed,
    skipped: release.closeCandidates.length - closed - failed,
    failed,
  };
}

export function closedPullAgentEligibleAt(
  prRow: S.IssueRow,
  pull: S.PullRow,
): string | null {
  if (pull.merged === 1) return pull.merged_at;
  if (prRow.state === "closed") return prRow.closed_at;
  return null;
}

export function timestampPlus(value: string | null, ms: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed + ms;
}

export async function cleanupClosedPullDevAgentsImpl(): Promise<{
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
