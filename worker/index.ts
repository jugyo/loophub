// `lh-worker` entry point: a resident process that tails the shared events table and runs the
// per-repo `.loophub/workflow.yml` commands (issue #52). Runs only while invoked (no daemon).
//   lh-worker [--poll-ms <ms>]
// Like lh-web, it touches the DB through core, so it must carry the --experimental-sqlite flag
// (the `lh-worker` npm script does). v1 is started via `npm run lh-worker`; an `lh worker`
// subcommand is intentionally out of scope.
import { startWorker } from "./runner.ts";

const argv = process.argv.slice(2);
let pollMs = Number(process.env.LOOPHUB_POLL_MS ?? 1000);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
}
// Guard against a missing/non-numeric value (NaN), which setInterval treats as 0ms — a busy loop.
if (!Number.isFinite(pollMs) || pollMs <= 0) pollMs = 1000;

const worker = startWorker({ pollMs });
console.error(`lh-worker started (events poll ${pollMs}ms)`);

let isShuttingDown = false;
const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  worker.stop();
  process.exit(0);
};

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, shutdown);
}
