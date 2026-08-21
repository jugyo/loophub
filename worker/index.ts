#!/usr/bin/env bun
// `lh-worker` entry point: a resident process that tails the shared events table, runs the
// per-repo `.loophub/workflow.yml` commands (issue #52), and owns non-git maintenance loops.
// Runs only while invoked (no daemon).
//   lh-worker [--poll-ms <ms>] [--dispatch-concurrency <n>] [--sweep-ms <ms>] [--usage-sweep-ms <ms>]
//             [--github-merge-sweep-ms <ms>] [--github-feedback-sweep-ms <ms>]
//             [--closed-pull-cleanup-sweep-ms <ms>]
//             [--conflict-sweep-ms <ms>] [--herdr-sweep-ms <ms>]
//             [--worktree-prune-sweep-ms <ms>]
// v1 is started via `npm run lh-worker`; an `lh worker` subcommand is intentionally out of scope.

import { workerLog } from "./logger.ts";
import {
  DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
  DEFAULT_CONFLICT_SWEEP_MS,
  DEFAULT_GITHUB_FEEDBACK_SWEEP_MS,
  DEFAULT_GITHUB_MERGE_SWEEP_MS,
  DEFAULT_HERDR_SWEEP_MS,
  DEFAULT_SWEEP_MS,
  DEFAULT_USAGE_SWEEP_MS,
  DEFAULT_WORKTREE_PRUNE_SWEEP_MS,
  maintenanceSummary,
  normalizeMaintenanceLoopOptions,
  startMaintenanceLoops,
  startNotificationSweep,
} from "./maintenance.ts";
import {
  DEFAULT_DISPATCH_CONCURRENCY,
  normalizeDispatchConcurrency,
  startWorker,
} from "./runner.ts";

const argv = process.argv.slice(2);
let pollMs = Number(process.env.LOOPHUB_POLL_MS ?? 1000);
let dispatchConcurrency = Number(
  process.env.LOOPHUB_DISPATCH_CONCURRENCY ?? DEFAULT_DISPATCH_CONCURRENCY,
);
let sweepMs = Number(process.env.LOOPHUB_SWEEP_MS ?? DEFAULT_SWEEP_MS);
let usageSweepMs = Number(
  process.env.LOOPHUB_USAGE_SWEEP_MS ?? DEFAULT_USAGE_SWEEP_MS,
);
let githubMergeSweepMs = Number(
  process.env.LOOPHUB_GITHUB_MERGE_SWEEP_MS ?? DEFAULT_GITHUB_MERGE_SWEEP_MS,
);
let githubFeedbackSweepMs = Number(
  process.env.LOOPHUB_GITHUB_FEEDBACK_SWEEP_MS ??
    DEFAULT_GITHUB_FEEDBACK_SWEEP_MS,
);
let closedPullCleanupSweepMs = Number(
  process.env.LOOPHUB_CLOSED_PULL_CLEANUP_SWEEP_MS ??
    DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
);
let conflictSweepMs = Number(
  process.env.LOOPHUB_CONFLICT_SWEEP_MS ?? DEFAULT_CONFLICT_SWEEP_MS,
);
let herdrSweepMs = Number(
  process.env.LOOPHUB_HERDR_SWEEP_MS ?? DEFAULT_HERDR_SWEEP_MS,
);
let worktreePruneSweepMs = Number(
  process.env.LOOPHUB_WORKTREE_PRUNE_SWEEP_MS ??
    DEFAULT_WORKTREE_PRUNE_SWEEP_MS,
);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
  else if (argv[i] === "--dispatch-concurrency")
    dispatchConcurrency = Number(argv[++i]);
  else if (argv[i] === "--sweep-ms") sweepMs = Number(argv[++i]);
  else if (argv[i] === "--usage-sweep-ms") usageSweepMs = Number(argv[++i]);
  else if (argv[i] === "--github-merge-sweep-ms")
    githubMergeSweepMs = Number(argv[++i]);
  else if (argv[i] === "--github-feedback-sweep-ms")
    githubFeedbackSweepMs = Number(argv[++i]);
  else if (argv[i] === "--closed-pull-cleanup-sweep-ms")
    closedPullCleanupSweepMs = Number(argv[++i]);
  else if (argv[i] === "--conflict-sweep-ms")
    conflictSweepMs = Number(argv[++i]);
  else if (argv[i] === "--herdr-sweep-ms") herdrSweepMs = Number(argv[++i]);
  else if (argv[i] === "--worktree-prune-sweep-ms")
    worktreePruneSweepMs = Number(argv[++i]);
}
// Guard against a missing/non-numeric value (NaN), which setInterval treats as 0ms — a busy loop.
if (!Number.isFinite(pollMs) || pollMs <= 0) pollMs = 1000;
dispatchConcurrency = normalizeDispatchConcurrency(dispatchConcurrency);

const maintenanceOptions = normalizeMaintenanceLoopOptions({
  sweepMs,
  usageSweepMs,
  githubMergeSweepMs,
  githubFeedbackSweepMs,
  closedPullCleanupSweepMs,
  conflictSweepMs,
  herdrSweepMs,
  worktreePruneSweepMs,
});
const worker = startWorker({ pollMs, concurrency: dispatchConcurrency });
const externalGitWatcher = process.env.LOOPHUB_GIT_WATCHER === "external";
const notificationSweepStop =
  externalGitWatcher && maintenanceOptions.sweepMs > 0
    ? startNotificationSweep(maintenanceOptions.sweepMs)
    : () => {};
// When serve starts lh-watcher-git alongside this process, disable the legacy local-git loops to
// avoid duplicate observations. A standalone lh-worker keeps the historical loops for backwards
// compatibility; operators can migrate to the split processes incrementally.
const maintenance = startMaintenanceLoops({
  ...maintenanceOptions,
  sweepMs: externalGitWatcher ? 0 : maintenanceOptions.sweepMs,
  conflictSweepMs: externalGitWatcher ? 0 : maintenanceOptions.conflictSweepMs,
  worktreePruneSweepMs: externalGitWatcher
    ? 0
    : maintenanceOptions.worktreePruneSweepMs,
});
const summary = maintenanceSummary({
  ...maintenanceOptions,
  sweepMs: externalGitWatcher ? 0 : maintenanceOptions.sweepMs,
  conflictSweepMs: externalGitWatcher ? 0 : maintenanceOptions.conflictSweepMs,
  worktreePruneSweepMs: externalGitWatcher
    ? 0
    : maintenanceOptions.worktreePruneSweepMs,
});
workerLog.info(
  `lh-worker started (events poll ${pollMs}ms; dispatch concurrency ${dispatchConcurrency}; heartbeat ${summary.workerHeartbeat}; PR sweep ${summary.pullSweep}; usage sweep ${summary.usageSweep}; github merge sweep ${summary.githubMergeSweep}; github feedback sweep ${summary.githubFeedbackSweep}; closed pull cleanup sweep ${summary.closedPullCleanupSweep}; conflict sweep ${summary.conflictSweep}; herdr sweep ${summary.herdrSweep}; worktree prune sweep ${summary.worktreePruneSweep})`,
);

let isShuttingDown = false;
const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  maintenance.stop();
  notificationSweepStop();
  worker.stop();
  process.exit(0);
};

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, shutdown);
}
