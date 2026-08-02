import {
  type GithubFeedbackSyncResult,
  syncGithubFeedback,
} from "../core/github-feedback-sync.ts";
import { syncGithubMergeStatus } from "../core/github-merge-sync.ts";
import { sweepPullConflicts } from "../core/pull-conflict-events.ts";
import type { WorktreeAutoPruneResult } from "../core/service/worktrees.ts";
import {
  events,
  notifications,
  sessions,
  terminal,
  workerRuntime,
  workflowRuns,
  worktrees,
} from "../core/service.ts";
import { sweepPullUpdates } from "../core/watcher.ts";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "../core/worker-protocol.ts";
import { workerLog } from "./logger.ts";

export const DEFAULT_SWEEP_MS = 5000;
export const DEFAULT_USAGE_SWEEP_MS = 10000;
// #800: GitHub merge-status checks shell out to `gh` (a real network call, subject to GitHub's
// rate limits), unlike the other sweeps here which only touch local git/DB — so this defaults to
// a much coarser interval than DEFAULT_SWEEP_MS.
export const DEFAULT_GITHUB_MERGE_SWEEP_MS = 60000;
// Feedback is a network sweep over three paginated GitHub endpoints per active Workflow PR. A
// minute keeps feedback reasonably fresh without turning the resident worker into a tight API poll.
export const DEFAULT_GITHUB_FEEDBACK_SWEEP_MS = 60000;
// #1121: killing dev agents whose PR has been closed (#926) is not time-sensitive the way cost
// reporting usage is — the agent has already lost its purpose, and the grace window before a kill
// is measured in hours — so this cleanup runs on its own coarse interval.
export const DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS = 600000;
// #1232: detecting an open PR's clean -> conflict transition recomputes merge-tree over every open
// PR, the same local git cost the merge-ready check in the pull sweep already pays. A base advances
// only when a sibling merges — infrequent, and a human merge is never seconds away — so this runs on
// its own coarser interval than the 5s pull sweep rather than piggybacking on it.
export const DEFAULT_CONFLICT_SWEEP_MS = 15000;
// #1665: herdr session snapshot sweep. lh-worker owns the herdr subprocess capture (session list +
// per-repo agent list) that terminal/sessions used to run per browser tab; the RPC is now a pure DB
// read of the snapshot this sweep persists. 3s matches the old per-tab poll's freshness, and the
// whole herdr load is now ~1 capture/tick regardless of how many tabs are open.
export const DEFAULT_HERDR_SWEEP_MS = 3000;
// #1837: worktrees of finished work are only removed a full day after the merge/close, so checking
// twice an hour is already far finer than the grace period. A tick that finds nothing due costs one
// `git worktree list` per repo.
export const DEFAULT_WORKTREE_PRUNE_SWEEP_MS = 1800000;
export const DEFAULT_WORKER_HEARTBEAT_MS = WORKER_HEARTBEAT_INTERVAL_MS;

export interface MaintenanceLoopOptions {
  sweepMs?: number;
  usageSweepMs?: number;
  githubMergeSweepMs?: number;
  githubFeedbackSweepMs?: number;
  closedPullCleanupSweepMs?: number;
  conflictSweepMs?: number;
  herdrSweepMs?: number;
  worktreePruneSweepMs?: number;
  workerHeartbeatMs?: number;
}

export interface NormalizedMaintenanceLoopOptions {
  sweepMs: number;
  usageSweepMs: number;
  githubMergeSweepMs: number;
  githubFeedbackSweepMs: number;
  closedPullCleanupSweepMs: number;
  conflictSweepMs: number;
  herdrSweepMs: number;
  worktreePruneSweepMs: number;
  workerHeartbeatMs: number;
}

export interface MaintenanceHandle {
  stop: () => void;
}

export function normalizeMaintenanceLoopOptions(
  opts: MaintenanceLoopOptions = {},
): NormalizedMaintenanceLoopOptions {
  return {
    sweepMs: finiteOrDefault(opts.sweepMs, DEFAULT_SWEEP_MS),
    usageSweepMs: finiteOrDefault(opts.usageSweepMs, DEFAULT_USAGE_SWEEP_MS),
    githubMergeSweepMs: finiteOrDefault(
      opts.githubMergeSweepMs,
      DEFAULT_GITHUB_MERGE_SWEEP_MS,
    ),
    githubFeedbackSweepMs: finiteOrDefault(
      opts.githubFeedbackSweepMs,
      DEFAULT_GITHUB_FEEDBACK_SWEEP_MS,
    ),
    closedPullCleanupSweepMs: finiteOrDefault(
      opts.closedPullCleanupSweepMs,
      DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    ),
    conflictSweepMs: finiteOrDefault(
      opts.conflictSweepMs,
      DEFAULT_CONFLICT_SWEEP_MS,
    ),
    herdrSweepMs: finiteOrDefault(opts.herdrSweepMs, DEFAULT_HERDR_SWEEP_MS),
    worktreePruneSweepMs: finiteOrDefault(
      opts.worktreePruneSweepMs,
      DEFAULT_WORKTREE_PRUNE_SWEEP_MS,
    ),
    workerHeartbeatMs: finiteOrDefault(
      opts.workerHeartbeatMs,
      DEFAULT_WORKER_HEARTBEAT_MS,
    ),
  };
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logLoopStarted(name: string): number {
  workerLog.info(`lh-worker: ${name} started`);
  return Date.now();
}

function logLoopCompleted(
  name: string,
  startedAt: number,
  details: Record<string, number>,
) {
  const fields = Object.entries(details).map(
    ([key, value]) => `${key}=${value}`,
  );
  workerLog.info(
    `lh-worker: ${name} completed duration_ms=${Date.now() - startedAt}${
      fields.length > 0 ? ` ${fields.join(" ")}` : ""
    }`,
  );
}

function logLoopFailed(name: string, startedAt: number, err: unknown) {
  const message = `lh-worker: ${name} failed duration_ms=${Date.now() - startedAt} error=${errorMessage(err)}`;
  workerLog.info(message);
  workerLog.error(message);
}

export function maintenanceSummary(opts: NormalizedMaintenanceLoopOptions) {
  return {
    pullSweep: opts.sweepMs > 0 ? `${opts.sweepMs}ms` : "off",
    usageSweep: opts.usageSweepMs > 0 ? `${opts.usageSweepMs}ms` : "off",
    githubMergeSweep:
      opts.githubMergeSweepMs > 0 ? `${opts.githubMergeSweepMs}ms` : "off",
    githubFeedbackSweep:
      opts.githubFeedbackSweepMs > 0
        ? `${opts.githubFeedbackSweepMs}ms`
        : "off",
    closedPullCleanupSweep:
      opts.closedPullCleanupSweepMs > 0
        ? `${opts.closedPullCleanupSweepMs}ms`
        : "off",
    conflictSweep:
      opts.conflictSweepMs > 0 ? `${opts.conflictSweepMs}ms` : "off",
    herdrSweep: opts.herdrSweepMs > 0 ? `${opts.herdrSweepMs}ms` : "off",
    worktreePruneSweep:
      opts.worktreePruneSweepMs > 0 ? `${opts.worktreePruneSweepMs}ms` : "off",
    workerHeartbeat:
      opts.workerHeartbeatMs > 0 ? `${opts.workerHeartbeatMs}ms` : "off",
  };
}

export function startMaintenanceLoops(
  opts: MaintenanceLoopOptions = {},
): MaintenanceHandle {
  const normalized = normalizeMaintenanceLoopOptions(opts);
  const workerStartedAt = new Date().toISOString();
  const stops = [
    normalized.workerHeartbeatMs > 0
      ? startWorkerHeartbeat(normalized.workerHeartbeatMs, workerStartedAt)
      : () => {},
    normalized.sweepMs > 0 ? startPullSweep(normalized.sweepMs) : () => {},
    normalized.usageSweepMs > 0
      ? startUsageSweep(normalized.usageSweepMs)
      : () => {},
    normalized.githubMergeSweepMs > 0
      ? startGithubMergeSweep(normalized.githubMergeSweepMs)
      : () => {},
    normalized.githubFeedbackSweepMs > 0
      ? startGithubFeedbackSweep(normalized.githubFeedbackSweepMs)
      : () => {},
    normalized.closedPullCleanupSweepMs > 0
      ? startClosedPullCleanupSweep(normalized.closedPullCleanupSweepMs)
      : () => {},
    normalized.conflictSweepMs > 0
      ? startConflictSweep(normalized.conflictSweepMs)
      : () => {},
    normalized.herdrSweepMs > 0
      ? startHerdrSnapshotSweep(normalized.herdrSweepMs)
      : () => {},
    normalized.worktreePruneSweepMs > 0
      ? startWorktreePruneSweep(normalized.worktreePruneSweepMs)
      : () => {},
  ];

  return {
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}

export function startWorkerHeartbeat(
  intervalMs = DEFAULT_WORKER_HEARTBEAT_MS,
  startedAt = new Date().toISOString(),
): () => void {
  const tick = () => workerRuntime.heartbeat(startedAt);
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// Auto-fire pull_request.updated by sweeping open PR head SHAs on the resident worker
// process. The sweep writes pull_request.updated rows straight to the shared DB for Web UI and
// worker polling. Unchanged PRs are a no-op, and manual `lh sync` / `sync/run` remain available.
export function startPullSweep(intervalMs = DEFAULT_SWEEP_MS): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("pull sweep");
    try {
      const emitted = await sweepPullUpdates();
      const mergeReady = await notifications.sweepMergeReady();
      logLoopCompleted("pull sweep", startedAt, {
        emitted_events: emitted.length,
        created_notifications: mergeReady.created.length,
      });
    } catch (err) {
      logLoopFailed("pull sweep", startedAt, err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Fire pull_request.merge_conflict for open PRs whose base advanced into a conflict while they
// waited for a human merge (#1232). This loop is an event source only — consumers (e.g. a Workflow
// parent polling `lh events`) observe the emitted events on their own; no session is launched here.
export function startConflictSweep(
  intervalMs = DEFAULT_CONFLICT_SWEEP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("conflict sweep");
    try {
      const result = await sweepPullConflicts();
      logLoopCompleted("conflict sweep", startedAt, {
        checked: result.checked,
        emitted_events: result.emitted,
      });
    } catch (err) {
      logLoopFailed("conflict sweep", startedAt, err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// #800: poll `gh` for the merge status of loophub PRs exported to GitHub (github_pulls) that
// aren't yet known-merged, recording a detected merge and firing pull_request.github_merged.
// Unlike startPullSweep this is a real network call, not a local git/DB check, so callers default
// it to a much coarser interval (DEFAULT_GITHUB_MERGE_SWEEP_MS).
export function startGithubMergeSweep(
  intervalMs = DEFAULT_GITHUB_MERGE_SWEEP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("github merge sweep");
    try {
      const emitted = await syncGithubMergeStatus();
      logLoopCompleted("github merge sweep", startedAt, {
        emitted_events: emitted.length,
      });
    } catch (err) {
      logLoopFailed("github merge sweep", startedAt, err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Poll GitHub feedback for open PRs attached to running Workflow runs. The core sweep persists
// dedupe state and emits source plus Workflow projection events per PR; this worker layer owns
// cadence and visible operational logging only. Failures are already isolated per PR, so log every
// one and let the next interval be the sole retry mechanism.
export function startGithubFeedbackSweep(
  intervalMs = DEFAULT_GITHUB_FEEDBACK_SWEEP_MS,
  sweep: () => Promise<GithubFeedbackSyncResult> = syncGithubFeedback,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("github feedback sweep");
    try {
      const result = await sweep();
      for (const failure of result.failures) {
        workerLog.error(
          `lh-worker: github feedback sweep PR failed pr=${failure.number} github_pr=${failure.github_number} error=${failure.error}`,
        );
      }
      logLoopCompleted("github feedback sweep", startedAt, {
        checked: result.checked,
        emitted_events: result.emitted.length,
        failures: result.failures.length,
      });
    } catch (err) {
      logLoopFailed("github feedback sweep", startedAt, err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Keep token usage fresh while lh-worker is resident. The core service owns transcript
// cursoring and parsing; this loop only schedules the sync and emits invalidation events for
// sessions that actually changed. Unchanged transcripts are skipped by mtime/size before parsing.
export function startUsageSweep(
  intervalMs = DEFAULT_USAGE_SWEEP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("usage sweep");
    try {
      const result = sessions.usageSync();
      for (const session of result.sessions) {
        if (session.status !== "updated") continue;
        const actor =
          sessions.authorFromSession(session.session_id) ?? "lh-worker";
        const payload = {
          session_id: session.session_id,
          messages: session.messages,
        };
        const targets = sessions.linkedTargets(session.session_id);
        if (targets.length === 0) {
          events.emit(null, "agent_session.usage_updated", actor, payload);
          continue;
        }
        for (const target of targets) {
          events.emit(target.repo_id, "agent_session.usage_updated", actor, {
            ...payload,
            [target.kind === "pull" ? "pr" : "issue"]: target.number,
          });
          if (target.kind === "pull") {
            const workflow = sessions.workflowUsageTarget(
              target.repo_id,
              target.number,
              session.session_id,
            );
            if (workflow) {
              workflowRuns.detectCostExceeded(target.repo, {
                run: workflow.runId,
                usageSession: session.session_id,
              });
            }
          }
        }
      }
      // #1123: persist the live aggregate tokens/sec into prune-resistant history so the rate time
      // series survives the 600s sample TTL. Same cadence as the sweep; no-op when no active rate.
      // Run after the usage_updated emissions so a rare insert failure can't suppress this tick's events.
      sessions.recordLiveRateSample();
      logLoopCompleted("usage sweep", startedAt, {
        synced: result.synced,
        skipped: result.skipped,
        missing: result.missing,
      });
    } catch (err) {
      logLoopFailed("usage sweep", startedAt, err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Kill dev agents left running more than an hour after their PR closes (#926), from one worker-owned
// Herdr tick. The closed PR has already lost its purpose and the grace window before a kill is
// measured in hours, so this cleanup is not time-sensitive and runs on its own coarse
// DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS interval. The enumeration, kill, and event bookkeeping live
// in core terminal services; this loop only schedules them and logs outcomes.
export function startClosedPullCleanupSweep(
  intervalMs = DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("closed pull cleanup sweep");
    try {
      const closedPullResult = await terminal.cleanupClosedPullDevAgents();
      logLoopCompleted("closed pull cleanup sweep", startedAt, {
        killed: closedPullResult.killed,
        skipped: closedPullResult.skipped,
        failed: closedPullResult.failed,
      });
    } catch (err) {
      logLoopFailed("closed pull cleanup sweep", startedAt, err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Snapshot running herdr sessions into the DB every tick (#1665) so terminal/sessions is a pure DB
// read instead of a per-tab herdr subprocess spawn. This loop is the single owner of that herdr
// capture; it persists the projected wire and emits terminal.sessions_updated only when the
// displayed state changed (the diff/emit bookkeeping lives in the core terminal service). Runs on
// its own 3s interval matching the old per-tab poll's freshness — coarser than the pull sweep since
// it is display-only and unrelated to pane cleanup.
export function startHerdrSnapshotSweep(
  intervalMs = DEFAULT_HERDR_SWEEP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("herdr snapshot sweep");
    try {
      const result = await terminal.snapshotHerdrSessions();
      logLoopCompleted("herdr snapshot sweep", startedAt, {
        repos: result.repos,
        running_repos: result.running_repos,
        // Non-zero means some repo's agent list could not be captured this tick and is showing
        // its last known agents instead (#2142) — the snapshot names those repos.
        capture_failed_repos: result.capture_failed_repos,
        changed: result.changed ? 1 : 0,
      });
    } catch (err) {
      logLoopFailed("herdr snapshot sweep", startedAt, err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Remove LoopHub worktrees whose PR merged or issue closed at least a day ago (#1837), so a
// finished PR's checkout does not linger forever. The candidate rules, the grace period and
// the destructive removal all live in core (worktrees.autoPrune); this loop owns cadence and
// visible operational logging only. Like every sweep here the tick awaits its git subprocesses
// rather than blocking, and the `running` guard means a prune that outlives its interval is never
// started twice — the other loops and the event runner keep going meanwhile. A failed removal is
// logged per worktree and simply retried on a later tick.
export function startWorktreePruneSweep(
  intervalMs = DEFAULT_WORKTREE_PRUNE_SWEEP_MS,
  prune: () => Promise<WorktreeAutoPruneResult> = () => worktrees.autoPrune(),
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("worktree prune sweep");
    try {
      const result = await prune();
      for (const failure of result.failed) {
        workerLog.error(
          `lh-worker: worktree prune sweep removal failed repo=${failure.repo} path=${failure.path} error=${failure.reason}`,
        );
      }
      logLoopCompleted("worktree prune sweep", startedAt, {
        scanned: result.scanned,
        candidates: result.candidates,
        removed: result.removed,
        failures: result.failed.length,
      });
    } catch (err) {
      logLoopFailed("worktree prune sweep", startedAt, err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
