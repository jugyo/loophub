import { worktreeRoot } from "../config.ts";
import { db } from "../db.ts";
import { isServiceError, ServiceError } from "../errors.ts";
import type { HerdrSessionsWire } from "../serialize.ts";
import { runHerdr, runHerdrCapture } from "../service/herdr-runner.ts";
import { repoOr404 } from "../service/shared.ts";
import * as S from "../store.ts";
import { carryOverFailedRepoSessions } from "./herdr-snapshot-carryover.ts";
import { herdrSnapshotSignature } from "./herdr-snapshot-signature.ts";
import {
  parseHerdrAgentPlacements,
  parseHerdrPaneKillTarget,
  parseHerdrSessionList,
  parseHerdrSessionListIfValid,
  reposWithRunningSession,
} from "./herdr-status.ts";
import { projectHerdrRepoSessions } from "./session-projection.ts";
import {
  HERDR_ID,
  herdrSessionName,
  herdrWorkspaceCloseArgv,
  type TerminalLaunchRepo,
} from "./terminal-launch.ts";

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
  const captured = await Promise.all(
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
        // Report the failure instead of returning null: null is also what a repo with no agents
        // to show projects to, and collapsing the two hid capture failures entirely (#2142).
        return { repo: repo.full_name, group: null, failed: true };
      }
      return {
        repo: repo.full_name,
        group: projectHerdrRepoSessions(
          repo,
          sessionName,
          agentsOut,
          worktreeRoot(),
        ),
        failed: false,
      };
    }),
  );
  const captureFailedRepos = captured
    .filter((c) => c.failed)
    .map((c) => c.repo);
  return {
    repos: captured.map((c) => c.group).filter((g) => g !== null),
    running_repos: runningRepos,
    ...(captureFailedRepos.length > 0
      ? { capture_failed_repos: captureFailedRepos }
      : {}),
  };
}

const TERMINAL_SESSIONS_UPDATED_EVENT = "terminal.sessions_updated";

export interface HerdrSnapshotSweepResult {
  repos: number;
  running_repos: number;
  // How many repos' `agent list` capture failed this tick (#2142), so the worker log records the
  // failure even for an operator who never opens the Agents page.
  capture_failed_repos: number;
  changed: boolean;
  captured_at: string;
}

export interface HerdrSnapshotSweepDeps {
  // Capture the current herdr snapshot. Defaults to the live subprocess sweep; injected in tests so
  // the persist/diff/emit logic can run without a herdr on PATH.
  sweep?: () => Promise<HerdrSessionsWire>;
}

// One worker tick (#1665): capture the live herdr snapshot, persist it as the single row
// terminal/sessions reads, and fire a global terminal.sessions_updated event only when the
// structural signature changed (herdrSnapshotSignature excludes token usage so a busy fleet does
// not flood the events table). This is the ONLY path that spawns herdr for session state now — the
// RPC is a pure DB read — so the whole herdr load is decoupled from the number of open browser tabs.
// captured_at is refreshed every tick so a stopped worker surfaces as staleness, not silent
// automatic fallback.
export async function snapshotHerdrSessionsImpl(
  deps: HerdrSnapshotSweepDeps = {},
): Promise<HerdrSnapshotSweepResult> {
  const capture = deps.sweep ?? sweepHerdrSessions;
  const captured = await capture();
  // A repo whose own capture failed keeps its last known agents (tagged stale_since) instead of
  // vanishing from the snapshot — see carryOverFailedRepoSessions (#2142).
  const snapshot = carryOverFailedRepoSessions(
    captured,
    S.getHerdrSessionSnapshot(),
  );
  const signature = herdrSnapshotSignature(snapshot);
  // The herdr capture is done. The stored signature is what decides whether this tick counts as a
  // change, so it commits with the event: a stored signature whose event was lost leaves clients on
  // the previous snapshot until some later tick happens to change the signature again.
  const record = db.transaction(() => {
    const stored = S.recordHerdrSessionSnapshot(snapshot, signature);
    if (stored.changed) {
      // Global (repo_id = null): the snapshot spans every repo, and clients invalidate one shared
      // terminal/sessions query rather than a repo-scoped one.
      S.emitEvent(null, TERMINAL_SESSIONS_UPDATED_EVENT, "lh-worker", {});
    }
    return stored;
  });
  return {
    repos: snapshot.repos.length,
    running_repos: snapshot.running_repos?.length ?? 0,
    capture_failed_repos: snapshot.capture_failed_repos?.length ?? 0,
    changed: record.changed,
    captured_at: record.captured_at,
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
