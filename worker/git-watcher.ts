// Local-git watcher process. This process observes local repositories and records facts in the
// shared database; it does not dispatch events or run external jobs.
import { sweepPullConflicts } from "../core/pull-conflict-events.ts";
import type { WorktreeAutoPruneResult } from "../core/service/worktrees.ts";
import { sweepPullUpdates } from "../core/watcher.ts";
import { workerLog } from "./logger.ts";

export const DEFAULT_PULL_SWEEP_MS = 5000;
export const DEFAULT_CONFLICT_SWEEP_MS = 15000;
export const DEFAULT_WORKTREE_PRUNE_SWEEP_MS = 1800000;

export interface GitWatcherOptions {
  pullSweepMs?: number;
  conflictSweepMs?: number;
  worktreePruneSweepMs?: number;
  pullSweep?: () => Promise<unknown[]>;
  conflictSweep?: () => Promise<{ checked: number; emitted: number }>;
  worktreePruneSweep?: () => Promise<WorktreeAutoPruneResult>;
}

export interface GitWatcherHandle {
  stop: () => void;
}

function intervalOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function startLoop(
  name: string,
  intervalMs: number,
  tick: () => Promise<void>,
): () => void {
  let stopped = false;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    const startedAt = Date.now();
    workerLog.info(`lh-watcher-git: ${name} started`);
    try {
      await tick();
      workerLog.info(
        `lh-watcher-git: ${name} completed duration_ms=${Date.now() - startedAt}`,
      );
    } catch (error) {
      workerLog.error(
        `lh-watcher-git: ${name} failed duration_ms=${Date.now() - startedAt} error=${errorMessage(error)}`,
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function startGitWatcher(
  options: GitWatcherOptions = {},
): GitWatcherHandle {
  const pullSweep = options.pullSweep ?? sweepPullUpdates;
  const conflictSweep = options.conflictSweep ?? sweepPullConflicts;
  const worktreePruneSweep = options.worktreePruneSweep;
  const stops = [
    intervalOrDefault(options.pullSweepMs, DEFAULT_PULL_SWEEP_MS) > 0
      ? startLoop(
          "pull sweep",
          intervalOrDefault(options.pullSweepMs, DEFAULT_PULL_SWEEP_MS),
          async () => {
            const emitted = await pullSweep();
            workerLog.info(
              `lh-watcher-git: pull sweep emitted_events=${emitted.length}`,
            );
          },
        )
      : () => {},
    intervalOrDefault(options.conflictSweepMs, DEFAULT_CONFLICT_SWEEP_MS) > 0
      ? startLoop(
          "conflict sweep",
          intervalOrDefault(options.conflictSweepMs, DEFAULT_CONFLICT_SWEEP_MS),
          async () => {
            const result = await conflictSweep();
            workerLog.info(
              `lh-watcher-git: conflict sweep checked=${result.checked} emitted_events=${result.emitted}`,
            );
          },
        )
      : () => {},
  ];
  if (worktreePruneSweep) {
    const intervalMs = intervalOrDefault(
      options.worktreePruneSweepMs,
      DEFAULT_WORKTREE_PRUNE_SWEEP_MS,
    );
    if (intervalMs > 0) {
      stops.push(
        startLoop("worktree prune sweep", intervalMs, async () => {
          const result = await worktreePruneSweep();
          for (const failure of result.failed) {
            workerLog.error(
              `lh-watcher-git: worktree prune failed repo=${failure.repo} path=${failure.path} error=${failure.reason}`,
            );
          }
          workerLog.info(
            `lh-watcher-git: worktree prune scanned=${result.scanned} candidates=${result.candidates} removed=${result.removed} failures=${result.failed.length}`,
          );
        }),
      );
    }
  }
  return {
    stop: () => {
      stops.forEach((stop) => {
        stop();
      });
    },
  };
}
