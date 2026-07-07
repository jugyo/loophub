import { syncGithubMergeStatus } from "../core/github-merge-sync.ts";
import { events, scheduledTasks, sessions, terminal } from "../core/service.ts";
import { sweepPullUpdates } from "../core/watcher.ts";
import { workerLog } from "./logger.ts";

export const DEFAULT_SWEEP_MS = 5000;
export const DEFAULT_USAGE_SWEEP_MS = 10000;
// #800: GitHub merge-status checks shell out to `gh` (a real network call, subject to GitHub's
// rate limits), unlike the other sweeps here which only touch local git/DB — so this defaults to
// a much coarser interval than DEFAULT_SWEEP_MS.
export const DEFAULT_GITHUB_MERGE_SWEEP_MS = 60000;
// #832: cost changes slowly (usage is itself refreshed only every DEFAULT_USAGE_SWEEP_MS), and the
// action — sending Esc once a dev agent passes the limit — is idempotent per PR via the
// dev.cost_stopped event, so a coarse interval is plenty and keeps the herdr `agent list` calls
// infrequent.
export const DEFAULT_COST_STOP_SWEEP_MS = 30000;
// #880: scheduled tasks fire at minute-precision times of day, so a coarse tick is enough to catch a
// due minute promptly. Each tick is only a cheap DB scan unless a task is actually due (then it
// launches a herdr tab), so this stays infrequent.
export const DEFAULT_SCHEDULED_TASK_SWEEP_MS = 30000;

export interface MaintenanceLoopOptions {
  sweepMs?: number;
  usageSweepMs?: number;
  githubMergeSweepMs?: number;
  costStopSweepMs?: number;
  scheduledTaskSweepMs?: number;
}

export interface NormalizedMaintenanceLoopOptions {
  sweepMs: number;
  usageSweepMs: number;
  githubMergeSweepMs: number;
  costStopSweepMs: number;
  scheduledTaskSweepMs: number;
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
    costStopSweepMs: finiteOrDefault(
      opts.costStopSweepMs,
      DEFAULT_COST_STOP_SWEEP_MS,
    ),
    scheduledTaskSweepMs: finiteOrDefault(
      opts.scheduledTaskSweepMs,
      DEFAULT_SCHEDULED_TASK_SWEEP_MS,
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
    costStopSweep:
      opts.costStopSweepMs > 0 ? `${opts.costStopSweepMs}ms` : "off",
    scheduledTaskSweep:
      opts.scheduledTaskSweepMs > 0 ? `${opts.scheduledTaskSweepMs}ms` : "off",
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
    normalized.githubMergeSweepMs > 0
      ? startGithubMergeSweep(normalized.githubMergeSweepMs)
      : () => {},
    normalized.costStopSweepMs > 0
      ? startCostStopSweep(normalized.costStopSweepMs)
      : () => {},
    normalized.scheduledTaskSweepMs > 0
      ? startScheduledTaskSweep(normalized.scheduledTaskSweepMs)
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
    const startedAt = logLoopStarted("pull sweep");
    try {
      const emitted = await sweepPullUpdates();
      logLoopCompleted("pull sweep", startedAt, {
        emitted_events: emitted.length,
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
        }
      }
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

// Fire scheduled tasks whose registered times have come due (#880). Each tick asks the core service
// which registered times are due now (across all repos) and launches a herdr tab for each; the
// once-per-day guarantee and the run-log bookkeeping live in scheduledTasks.sweep, so this loop only
// schedules it and logs the outcome.
export function startScheduledTaskSweep(
  intervalMs = DEFAULT_SCHEDULED_TASK_SWEEP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("scheduled task sweep");
    try {
      const result = await scheduledTasks.sweep();
      logLoopCompleted("scheduled task sweep", startedAt, {
        fired: result.fired,
      });
    } catch (err) {
      logLoopFailed("scheduled task sweep", startedAt, err);
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

// Stop `lh build` agents that pass the top-level cost limit by sending Esc to their herdr pane
// (#832). This is worker-owned maintenance (not a UI cache invalidation): the enumeration, cost
// judgement, keystroke, and dev.cost_stopped bookkeeping all live in terminal.enforceDevCostLimits;
// this loop only schedules it and logs the outcome.
export function startCostStopSweep(
  intervalMs = DEFAULT_COST_STOP_SWEEP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("cost stop sweep");
    try {
      const result = await terminal.enforceDevCostLimits();
      logLoopCompleted("cost stop sweep", startedAt, {
        stopped: result.stopped,
        skipped: result.skipped,
        failed: result.failed,
      });
    } catch (err) {
      logLoopFailed("cost stop sweep", startedAt, err);
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
