import { syncGithubMergeStatus } from "../core/github-merge-sync.ts";
import { events, sessions, terminal } from "../core/service.ts";
import { HERDR_INACTIVE_CLEANUP_INTERVAL_MS } from "../core/terminal/herdr-inactive-cleanup.ts";
import { sweepPullUpdates } from "../core/watcher.ts";
import { workerLog } from "./logger.ts";

export const DEFAULT_SWEEP_MS = 5000;
export const DEFAULT_USAGE_SWEEP_MS = 10000;
export const DEFAULT_HERDR_INACTIVE_CLEANUP_MS =
  HERDR_INACTIVE_CLEANUP_INTERVAL_MS;
// #800: GitHub merge-status checks shell out to `gh` (a real network call, subject to GitHub's
// rate limits), unlike the other sweeps here which only touch local git/DB — so this defaults to
// a much coarser interval than DEFAULT_SWEEP_MS.
export const DEFAULT_GITHUB_MERGE_SWEEP_MS = 60000;

export interface MaintenanceLoopOptions {
  sweepMs?: number;
  usageSweepMs?: number;
  herdrInactiveCleanupMs?: number;
  githubMergeSweepMs?: number;
}

export interface NormalizedMaintenanceLoopOptions {
  sweepMs: number;
  usageSweepMs: number;
  herdrInactiveCleanupMs: number;
  githubMergeSweepMs: number;
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
    herdrInactiveCleanupMs: finiteOrDefault(
      opts.herdrInactiveCleanupMs,
      DEFAULT_HERDR_INACTIVE_CLEANUP_MS,
    ),
    githubMergeSweepMs: finiteOrDefault(
      opts.githubMergeSweepMs,
      DEFAULT_GITHUB_MERGE_SWEEP_MS,
    ),
  };
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value;
}

export function maintenanceSummary(opts: NormalizedMaintenanceLoopOptions) {
  return {
    pullSweep: opts.sweepMs > 0 ? `${opts.sweepMs}ms` : "off",
    usageSweep: opts.usageSweepMs > 0 ? `${opts.usageSweepMs}ms` : "off",
    herdrInactiveCleanup:
      opts.herdrInactiveCleanupMs > 0
        ? `${opts.herdrInactiveCleanupMs}ms`
        : "off",
    githubMergeSweep:
      opts.githubMergeSweepMs > 0 ? `${opts.githubMergeSweepMs}ms` : "off",
  };
}

export function startMaintenanceLoops(
  opts: MaintenanceLoopOptions = {},
): MaintenanceHandle {
  const normalized = normalizeMaintenanceLoopOptions(opts);
  const stops = [
    normalized.sweepMs > 0 ? startPullSweep(normalized.sweepMs) : () => {},
    normalized.usageSweepMs > 0
      ? startUsageSweep(normalized.usageSweepMs)
      : () => {},
    normalized.herdrInactiveCleanupMs > 0
      ? startHerdrInactiveCleanup(normalized.herdrInactiveCleanupMs)
      : () => {},
    normalized.githubMergeSweepMs > 0
      ? startGithubMergeSweep(normalized.githubMergeSweepMs)
      : () => {},
  ];

  return {
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}

// Auto-fire pull_request.updated by sweeping open PR head SHAs on the resident worker
// process. The sweep writes pull_request.updated rows straight to the shared DB; lh-web's
// event tail forwards them to SSE subscribers. Unchanged PRs are a no-op, and manual
// `lh sync` / `sync/run` remain available.
export function startPullSweep(intervalMs = DEFAULT_SWEEP_MS): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await sweepPullUpdates();
    } catch (err) {
      workerLog.error(
        `lh-worker: pull sweep error: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    try {
      await syncGithubMergeStatus();
    } catch (err) {
      workerLog.error(
        `lh-worker: github merge sweep error: ${err instanceof Error ? err.message : String(err)}`,
      );
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
        }
      }
    } catch (err) {
      workerLog.error(
        `lh-worker: usage sweep error: ${err instanceof Error ? err.message : String(err)}`,
      );
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

// Close old Herdr panes from the backend on a coarse interval (#666). This is worker-owned
// maintenance, not a UI cache invalidation.
export function startHerdrInactiveCleanup(
  intervalMs = DEFAULT_HERDR_INACTIVE_CLEANUP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await terminal.cleanupInactiveAgents();
      if (result.closed > 0 || result.failed > 0) {
        const message = `lh-worker: herdr inactive cleanup: closed ${result.closed}, failed ${result.failed}`;
        if (result.failed > 0) workerLog.error(message);
        else workerLog.info(message);
      }
    } catch (err) {
      workerLog.error(
        `lh-worker: herdr inactive cleanup error: ${err instanceof Error ? err.message : String(err)}`,
      );
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
