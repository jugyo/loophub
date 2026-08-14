#!/usr/bin/env -S node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx
// `lh-watcher-git` observes local git state and records events in the shared database.
import { worktrees } from "../core/service.ts";
import {
  DEFAULT_CONFLICT_SWEEP_MS,
  DEFAULT_PULL_SWEEP_MS,
  DEFAULT_WORKTREE_PRUNE_SWEEP_MS,
  startGitWatcher,
} from "./git-watcher.ts";
import { workerLog } from "./logger.ts";

const argv = process.argv.slice(2);
let pullSweepMs = Number(
  process.env.LOOPHUB_PULL_SWEEP_MS ?? DEFAULT_PULL_SWEEP_MS,
);
let conflictSweepMs = Number(
  process.env.LOOPHUB_CONFLICT_SWEEP_MS ?? DEFAULT_CONFLICT_SWEEP_MS,
);
let worktreePruneSweepMs = Number(
  process.env.LOOPHUB_WORKTREE_PRUNE_SWEEP_MS ??
    DEFAULT_WORKTREE_PRUNE_SWEEP_MS,
);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--pull-sweep-ms") pullSweepMs = Number(argv[++i]);
  else if (argv[i] === "--conflict-sweep-ms")
    conflictSweepMs = Number(argv[++i]);
  else if (argv[i] === "--worktree-prune-sweep-ms")
    worktreePruneSweepMs = Number(argv[++i]);
}

const watcher = startGitWatcher({
  pullSweepMs,
  conflictSweepMs,
  worktreePruneSweepMs,
  worktreePruneSweep: () => worktrees.autoPrune(),
});
const keepAlive = setInterval(() => {}, 60_000);
workerLog.info(
  `lh-watcher-git started (pull sweep ${pullSweepMs}ms; conflict sweep ${conflictSweepMs}ms; worktree prune sweep ${worktreePruneSweepMs}ms)`,
);

let stopped = false;
const shutdown = () => {
  if (stopped) return;
  stopped = true;
  clearInterval(keepAlive);
  watcher.stop();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, shutdown);
