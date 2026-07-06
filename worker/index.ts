// `lh-worker` entry point: a resident process that tails the shared events table, runs the
// per-repo `.loophub/workflow.yml` commands (issue #52), and owns resident maintenance loops.
// Runs only while invoked (no daemon).
//   lh-worker [--poll-ms <ms>] [--sweep-ms <ms>] [--usage-sweep-ms <ms>] [--herdr-inactive-cleanup-ms <ms>]
//             [--github-merge-sweep-ms <ms>]
// Like lh-web, it touches the DB through core, so it must carry the --experimental-sqlite flag
// (the `lh-worker` npm script does). v1 is started via `npm run lh-worker`; an `lh worker`
// subcommand is intentionally out of scope.
import {
  DEFAULT_GITHUB_MERGE_SWEEP_MS,
  DEFAULT_HERDR_INACTIVE_CLEANUP_MS,
  DEFAULT_SWEEP_MS,
  DEFAULT_USAGE_SWEEP_MS,
  maintenanceSummary,
  normalizeMaintenanceLoopOptions,
  startMaintenanceLoops,
} from "./maintenance.ts";
import { startWorker } from "./runner.ts";

const argv = process.argv.slice(2);
let pollMs = Number(process.env.LOOPHUB_POLL_MS ?? 1000);
let sweepMs = Number(process.env.LOOPHUB_SWEEP_MS ?? DEFAULT_SWEEP_MS);
let usageSweepMs = Number(
  process.env.LOOPHUB_USAGE_SWEEP_MS ?? DEFAULT_USAGE_SWEEP_MS,
);
let herdrInactiveCleanupMs = Number(
  process.env.LOOPHUB_HERDR_INACTIVE_CLEANUP_MS ??
    DEFAULT_HERDR_INACTIVE_CLEANUP_MS,
);
let githubMergeSweepMs = Number(
  process.env.LOOPHUB_GITHUB_MERGE_SWEEP_MS ?? DEFAULT_GITHUB_MERGE_SWEEP_MS,
);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
  else if (argv[i] === "--sweep-ms") sweepMs = Number(argv[++i]);
  else if (argv[i] === "--usage-sweep-ms") usageSweepMs = Number(argv[++i]);
  else if (argv[i] === "--herdr-inactive-cleanup-ms")
    herdrInactiveCleanupMs = Number(argv[++i]);
  else if (argv[i] === "--github-merge-sweep-ms")
    githubMergeSweepMs = Number(argv[++i]);
}
// Guard against a missing/non-numeric value (NaN), which setInterval treats as 0ms — a busy loop.
if (!Number.isFinite(pollMs) || pollMs <= 0) pollMs = 1000;

const maintenanceOptions = normalizeMaintenanceLoopOptions({
  sweepMs,
  usageSweepMs,
  herdrInactiveCleanupMs,
  githubMergeSweepMs,
});
const worker = startWorker({ pollMs });
const maintenance = startMaintenanceLoops(maintenanceOptions);
const summary = maintenanceSummary(maintenanceOptions);
console.error(
  `lh-worker started (events poll ${pollMs}ms; PR sweep ${summary.pullSweep}; usage sweep ${summary.usageSweep}; herdr inactive cleanup ${summary.herdrInactiveCleanup}; github merge sweep ${summary.githubMergeSweep})`,
);

let isShuttingDown = false;
const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  maintenance.stop();
  worker.stop();
  process.exit(0);
};

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, shutdown);
}
