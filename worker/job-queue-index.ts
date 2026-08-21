#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { jobs } from "../core/service.ts";
import {
  createJobQueue,
  DEFAULT_JOB_CONCURRENCY,
  normalizeJobConcurrency,
} from "./job-queue.ts";
// `lh-job-queue` is the independent lifecycle for externally effectful jobs. The shared jobs table
// and claim protocol are introduced by the next migration; keeping this process boundary now
// prevents future job execution from being coupled to event observation.
import { workerLog } from "./logger.ts";
import {
  DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
  startClosedPullCleanupSweep,
} from "./maintenance.ts";

const argv = process.argv.slice(2);
let pollMs = Number(process.env.LOOPHUB_JOB_POLL_MS ?? 1000);
let concurrency = Number(
  process.env.LOOPHUB_JOB_CONCURRENCY ?? DEFAULT_JOB_CONCURRENCY,
);
let closedPullCleanupSweepMs = Number(
  process.env.LOOPHUB_CLOSED_PULL_CLEANUP_SWEEP_MS ??
    DEFAULT_CLOSED_PULL_CLEANUP_SWEEP_MS,
);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
  else if (argv[i] === "--concurrency") concurrency = Number(argv[++i]);
  else if (argv[i] === "--closed-pull-cleanup-sweep-ms")
    closedPullCleanupSweepMs = Number(argv[++i]);
}
concurrency = normalizeJobConcurrency(concurrency);
const runShell = (job: { id: number; params: string }): Promise<void> => {
  let params: { command?: string; cwd?: string; env?: Record<string, string> };
  try {
    params = JSON.parse(job.params) as typeof params;
  } catch (error) {
    jobs.finish(job.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return Promise.resolve();
  }
  if (!params.command) {
    jobs.finish(job.id, {
      status: "failed",
      error: "job shell command is missing",
    });
    return Promise.resolve();
  }
  const command = params.command;
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      cwd: params.cwd,
      env: { ...process.env, ...params.env } as NodeJS.ProcessEnv,
    });
    const heartbeat = setInterval(() => jobs.heartbeat(job.id), 5000);
    child.on("error", (error: Error) => {
      clearInterval(heartbeat);
      jobs.finish(job.id, { status: "failed", error: error.message });
      resolve();
    });
    child.on("close", (code: number | null) => {
      clearInterval(heartbeat);
      jobs.finish(
        job.id,
        code === 0
          ? { status: "done", result: { exit_code: code } }
          : { status: "failed", error: `command exited with code ${code}` },
      );
      resolve();
    });
  });
};

const queue = createJobQueue({
  concurrency,
  claimNext: jobs.claimNext,
  run: async (job) => {
    if (job.type === "shell") await runShell(job);
    else
      jobs.finish(job.id, {
        status: "failed",
        error: `unknown job type: ${job.type}`,
      });
  },
  onError: (error) =>
    workerLog.error(
      `lh-job-queue: job failed error=${error instanceof Error ? error.message : error}`,
    ),
});
const timer = setInterval(
  () => {
    try {
      queue.tick();
    } catch (error) {
      workerLog.error(
        `lh-job-queue: tick failed error=${error instanceof Error ? error.message : error}`,
      );
    }
  },
  pollMs > 0 ? pollMs : 1000,
);
const cleanupStop =
  closedPullCleanupSweepMs > 0
    ? startClosedPullCleanupSweep(closedPullCleanupSweepMs)
    : () => {};
workerLog.info(
  `lh-job-queue started (poll ${pollMs}ms; concurrency ${concurrency}; closed pull cleanup sweep ${closedPullCleanupSweepMs}ms)`,
);

let stopped = false;
const shutdown = () => {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  cleanupStop();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, shutdown);
