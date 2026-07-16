import {
  type GithubFeedbackSyncResult,
  syncGithubFeedback,
} from "../core/github-feedback-sync.ts";
import { syncGithubMergeStatus } from "../core/github-merge-sync.ts";
import { sweepPullConflicts } from "../core/pull-conflict-events.ts";
import {
  events,
  notifications,
  scheduledTasks,
  sessions,
  terminal,
  workflowRuns,
} from "../core/service.ts";
import { sweepPullUpdates } from "../core/watcher.ts";
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
// #832: cost changes slowly (usage is itself refreshed only every DEFAULT_USAGE_SWEEP_MS), and the
// action — sending Esc once a dev agent passes the limit — is idempotent per PR via the
// dev.cost_stopped event, so a coarse interval is plenty and keeps the herdr `agent list` calls
// infrequent. #1121 split closed-PR agent cleanup out of this loop into
// startClosedPullCleanupSweep; this default now governs cost-limit enforcement only, keeping the
// 30s freshness that cost stopping relies on.
export const DEFAULT_COST_STOP_SWEEP_MS = 30000;
// #1121: killing dev agents whose PR has been closed (#926) is not time-sensitive the way cost
// stopping is — the agent has already lost its purpose, and the grace window before a kill is
// measured in hours — so this cleanup runs on its own, much coarser interval than the cost-stop
// sweep instead of piggybacking on the 30s tick.
export const DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS = 600000;
// #880: scheduled tasks fire at minute-precision times of day, so a coarse tick is enough to catch a
// due minute promptly. Each tick is only a cheap DB scan unless a task is actually due (then it
// launches a herdr tab), so this stays infrequent.
export const DEFAULT_SCHEDULED_TASK_SWEEP_MS = 30000;
// #1232: detecting an open PR's clean -> conflict transition recomputes merge-tree over every open
// PR, the same local git cost the merge-ready check in the pull sweep already pays. A base advances
// only when a sibling merges — infrequent, and a human merge is never seconds away — so this runs on
// its own coarser interval than the 5s pull sweep rather than piggybacking on it.
export const DEFAULT_CONFLICT_SWEEP_MS = 15000;
// #1358: how often the worker checks for a Workflow run that stopped making progress. A run only
// stalls when its Execute child never declared turn done (a rare, human-recoverable failure), so a
// coarse tick is plenty — this only marks the run needs-human and files an Inbox message.
export const DEFAULT_WORKFLOW_STALL_SWEEP_MS = 60000;
// A run is treated as stalled when it has had no lifecycle activity (run started/updated, step
// launched, turn-done declared) for this long. Generous by design: agent turns can legitimately run
// for many minutes, and surfacing to a human is a fallback, not a tight watchdog.
export const DEFAULT_WORKFLOW_STALL_THRESHOLD_MS = 1800000;

export interface MaintenanceLoopOptions {
  sweepMs?: number;
  usageSweepMs?: number;
  githubMergeSweepMs?: number;
  githubFeedbackSweepMs?: number;
  costStopSweepMs?: number;
  closedPullCleanupSweepMs?: number;
  scheduledTaskSweepMs?: number;
  conflictSweepMs?: number;
  workflowStallSweepMs?: number;
  workflowStallThresholdMs?: number;
}

export interface NormalizedMaintenanceLoopOptions {
  sweepMs: number;
  usageSweepMs: number;
  githubMergeSweepMs: number;
  githubFeedbackSweepMs: number;
  costStopSweepMs: number;
  closedPullCleanupSweepMs: number;
  scheduledTaskSweepMs: number;
  conflictSweepMs: number;
  workflowStallSweepMs: number;
  workflowStallThresholdMs: number;
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
    costStopSweepMs: finiteOrDefault(
      opts.costStopSweepMs,
      DEFAULT_COST_STOP_SWEEP_MS,
    ),
    closedPullCleanupSweepMs: finiteOrDefault(
      opts.closedPullCleanupSweepMs,
      DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
    ),
    scheduledTaskSweepMs: finiteOrDefault(
      opts.scheduledTaskSweepMs,
      DEFAULT_SCHEDULED_TASK_SWEEP_MS,
    ),
    conflictSweepMs: finiteOrDefault(
      opts.conflictSweepMs,
      DEFAULT_CONFLICT_SWEEP_MS,
    ),
    workflowStallSweepMs: finiteOrDefault(
      opts.workflowStallSweepMs,
      DEFAULT_WORKFLOW_STALL_SWEEP_MS,
    ),
    workflowStallThresholdMs: finiteOrDefault(
      opts.workflowStallThresholdMs,
      DEFAULT_WORKFLOW_STALL_THRESHOLD_MS,
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
    costStopSweep:
      opts.costStopSweepMs > 0 ? `${opts.costStopSweepMs}ms` : "off",
    closedPullCleanupSweep:
      opts.closedPullCleanupSweepMs > 0
        ? `${opts.closedPullCleanupSweepMs}ms`
        : "off",
    scheduledTaskSweep:
      opts.scheduledTaskSweepMs > 0 ? `${opts.scheduledTaskSweepMs}ms` : "off",
    conflictSweep:
      opts.conflictSweepMs > 0 ? `${opts.conflictSweepMs}ms` : "off",
    workflowStallSweep:
      opts.workflowStallSweepMs > 0 ? `${opts.workflowStallSweepMs}ms` : "off",
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
    normalized.githubFeedbackSweepMs > 0
      ? startGithubFeedbackSweep(normalized.githubFeedbackSweepMs)
      : () => {},
    normalized.costStopSweepMs > 0
      ? startCostStopSweep(normalized.costStopSweepMs)
      : () => {},
    normalized.closedPullCleanupSweepMs > 0
      ? startClosedPullCleanupSweep(normalized.closedPullCleanupSweepMs)
      : () => {},
    normalized.scheduledTaskSweepMs > 0
      ? startScheduledTaskSweep(normalized.scheduledTaskSweepMs)
      : () => {},
    normalized.conflictSweepMs > 0
      ? startConflictSweep(normalized.conflictSweepMs)
      : () => {},
    normalized.workflowStallSweepMs > 0
      ? startWorkflowStallSweep(
          normalized.workflowStallSweepMs,
          normalized.workflowStallThresholdMs,
        )
      : () => {},
  ];

  return {
    stop: () => {
      for (const stop of stops) stop();
    },
  };
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
// waited for a human merge (#1232). This loop is an event source only — delivery to whatever
// subscribed (via `lh subscribe`) happens in the worker's event tail, and what the subscriber does
// with it is its own wiring; no session is launched here.
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

// Surface a Workflow run that stopped making progress (#1358). A run stalls only when its Execute
// child never declared turn done — a rare, human-recoverable failure — so the sweep does not try to
// recover it: it marks the run needs-human and files an Inbox message, and a human resumes or stops
// it. The decision (which runs are past the threshold, the hold, the Inbox message) lives in the
// core service; this loop only schedules it and logs the outcome.
export function startWorkflowStallSweep(
  intervalMs = DEFAULT_WORKFLOW_STALL_SWEEP_MS,
  thresholdMs = DEFAULT_WORKFLOW_STALL_THRESHOLD_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = logLoopStarted("workflow stall sweep");
    try {
      const result = workflowRuns.sweepStalledRuns({ thresholdMs });
      logLoopCompleted("workflow stall sweep", startedAt, {
        held: result.held.length,
        failed: result.failed.length,
      });
    } catch (err) {
      logLoopFailed("workflow stall sweep", startedAt, err);
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
// dedupe state and emits one event per PR; this worker layer owns cadence and visible operational
// logging only. Failures are already isolated per PR, so log every one and let the next interval be
// the sole retry mechanism.
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
              events.emit(target.repo_id, "workflow_run.usage_updated", actor, {
                id: workflow.runId,
                number: target.number,
                pr_number: target.number,
                parent_session_id: workflow.parentSessionId,
                session_id: session.session_id,
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

// Stop build/dev agents that have run past their cost limit, from one worker-owned Herdr tick (#832).
// The stop is idempotent per PR via the dev.cost_stopped event, so this stays on the coarse
// DEFAULT_COST_STOP_SWEEP_MS interval; the enumeration, decision, keystroke, and event bookkeeping
// live in core terminal services and this loop only schedules them and logs outcomes. #1121 split
// closed-PR agent cleanup into startClosedPullCleanupSweep so cost freshness is not coupled to it.
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
      const costResult = await terminal.enforceDevCostLimits();
      logLoopCompleted("cost stop sweep", startedAt, {
        stopped: costResult.stopped,
        skipped: costResult.skipped,
        failed: costResult.failed,
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

// Kill dev agents left running more than an hour after their PR closes (#926), from one worker-owned
// Herdr tick. #1121 split this off startCostStopSweep: the closed PR has already lost its purpose and
// the grace window before a kill is measured in hours, so this cleanup is not time-sensitive and runs
// on its own coarse DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS interval instead of the 30s cost tick. The
// enumeration, kill, and event bookkeeping live in core terminal services; this loop only schedules
// them and logs outcomes.
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
