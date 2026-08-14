#!/usr/bin/env -S node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx
import { workerLog } from "./logger.ts";
// `lh-watcher-github` owns observations that call GitHub APIs. Local-git and agent observations
// live in separate watcher processes so their cadence and failures cannot block one another.
import {
  DEFAULT_GITHUB_FEEDBACK_SWEEP_MS,
  DEFAULT_GITHUB_MERGE_SWEEP_MS,
  startGithubFeedbackSweep,
  startGithubMergeSweep,
} from "./maintenance.ts";

const argv = process.argv.slice(2);
let mergeSweepMs = Number(
  process.env.LOOPHUB_GITHUB_MERGE_SWEEP_MS ?? DEFAULT_GITHUB_MERGE_SWEEP_MS,
);
let feedbackSweepMs = Number(
  process.env.LOOPHUB_GITHUB_FEEDBACK_SWEEP_MS ??
    DEFAULT_GITHUB_FEEDBACK_SWEEP_MS,
);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--merge-sweep-ms") mergeSweepMs = Number(argv[++i]);
  else if (argv[i] === "--feedback-sweep-ms")
    feedbackSweepMs = Number(argv[++i]);
}

const stops = [
  mergeSweepMs > 0 ? startGithubMergeSweep(mergeSweepMs) : () => {},
  feedbackSweepMs > 0 ? startGithubFeedbackSweep(feedbackSweepMs) : () => {},
];
const keepAlive = setInterval(() => {}, 60_000);
workerLog.info(
  `lh-watcher-github started (merge sweep ${mergeSweepMs}ms; feedback sweep ${feedbackSweepMs}ms)`,
);

let stopped = false;
const shutdown = () => {
  if (stopped) return;
  stopped = true;
  clearInterval(keepAlive);
  for (const stop of stops) stop();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, shutdown);
