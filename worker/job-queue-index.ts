#!/usr/bin/env bun
import { spawnProcess } from "../core/process.ts";
import { jobs, workflowAgentStop } from "../core/service.ts";
import { STOP_WORKFLOW_AGENTS_JOB } from "../core/workflow-agent-stop-job.ts";
import {
  createJobQueue,
  DEFAULT_JOB_CONCURRENCY,
  normalizeJobConcurrency,
} from "./job-queue.ts";
// `lh-job-queue` is the independent lifecycle for externally effectful jobs. Interrupted jobs are
// failed, never requeued, because a command may have partially applied its side effects (see the
// Processes section of README.ja.md).
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
// How long a graceful stop waits for claimed jobs before interrupting them.
const shutdownGraceMs = Number(
  process.env.LOOPHUB_JOB_SHUTDOWN_GRACE_MS ?? 10_000,
);
// Every claimed job heartbeats at this interval; a running row whose heartbeat is older than the
// stale threshold has no live queue process behind it.
const HEARTBEAT_MS = 5000;
const STALE_MS = 60_000;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
  else if (argv[i] === "--concurrency") concurrency = Number(argv[++i]);
  else if (argv[i] === "--closed-pull-cleanup-sweep-ms")
    closedPullCleanupSweepMs = Number(argv[++i]);
}
concurrency = normalizeJobConcurrency(concurrency);
// Shell commands run in their own process group so a stop can signal every descendant.
const shellChildren = new Map<number, ReturnType<typeof spawnProcess>>();
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
    let child: ReturnType<typeof spawnProcess>;
    try {
      child = spawnProcess(["sh", "-c", command], {
        cwd: params.cwd,
        env: { ...process.env, ...params.env },
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      });
    } catch (error) {
      jobs.finish(job.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      resolve();
      return;
    }
    shellChildren.set(job.id, child);
    child.exited
      .then((code) => {
        jobs.finish(
          job.id,
          code === 0
            ? { status: "done", result: { exit_code: code } }
            : { status: "failed", error: `command exited with code ${code}` },
        );
        resolve();
      })
      .catch((error) => {
        jobs.finish(job.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        resolve();
      })
      .finally(() => shellChildren.delete(job.id));
  });
};

const runWorkflowAgentStop = async (job: {
  id: number;
  repo_id: number | null;
  params: string;
}): Promise<void> => {
  try {
    const params = JSON.parse(job.params) as { run?: number };
    if (!job.repo_id || !Number.isInteger(params.run)) {
      throw new Error("workflow agent stop job parameters are invalid");
    }
    const repo = jobs.repoName(job.repo_id);
    const result = await workflowAgentStop.run(repo, { run: params.run! });
    jobs.finish(job.id, { status: "done", result });
  } catch (error) {
    jobs.finish(job.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const queue = createJobQueue({
  concurrency,
  claimNext: jobs.claimNext,
  run: async (job) => {
    const heartbeat = setInterval(() => jobs.heartbeat(job.id), HEARTBEAT_MS);
    try {
      if (job.type === "shell") await runShell(job);
      else if (job.type === STOP_WORKFLOW_AGENTS_JOB)
        await runWorkflowAgentStop(job);
      else
        jobs.finish(job.id, {
          status: "failed",
          error: `unknown job type: ${job.type}`,
        });
    } finally {
      clearInterval(heartbeat);
    }
  },
  onError: (error) =>
    workerLog.error(
      `lh-job-queue: job failed error=${error instanceof Error ? error.message : error}`,
    ),
});
// Graceful stop: claim nothing new, give claimed jobs a bounded grace period, then fail the rest as
// interrupted (never requeued) and signal each shell command's process group.
let stopped = false;
const shutdown = async () => {
  if (stopped) return;
  stopped = true;
  queue.stop();
  clearInterval(timer);
  cleanupStop();
  if (!(await queue.drain(shutdownGraceMs))) {
    for (const id of queue.runningIds()) {
      jobs.finish(id, {
        status: "failed",
        error:
          "interrupted: lh-job-queue stopped before the job finished. Not retried automatically",
      });
      workerLog.error(`lh-job-queue: interrupted running job id=${id}`);
      const child = shellChildren.get(id);
      if (child) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
    }
  }
  process.exit(0);
};
// Registered before the first sweep so a signal during startup still takes the graceful path. The
// handler runs from the event loop, after the synchronous startup below has defined `timer` and
// `cleanupStop`.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void shutdown());

// Fail running rows left behind by a queue process that exited without finishing them. They are not
// requeued: the command may have partially applied its side effects.
const sweepStale = () => {
  const cutoff = new Date(Date.now() - STALE_MS)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");
  for (const job of jobs.failStale(
    cutoff,
    queue.runningIds(),
    "job heartbeat went stale; the queue process stopped before the job finished. Not retried automatically",
  ))
    workerLog.error(
      `lh-job-queue: stale running job failed id=${job.id} type=${job.type} heartbeat_at=${job.heartbeat_at}`,
    );
};
try {
  sweepStale();
} catch (error) {
  workerLog.error(
    `lh-job-queue: stale sweep failed error=${error instanceof Error ? error.message : error}`,
  );
}
const timer = setInterval(
  () => {
    try {
      sweepStale();
    } catch (error) {
      workerLog.error(
        `lh-job-queue: stale sweep failed error=${error instanceof Error ? error.message : error}`,
      );
    }
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
