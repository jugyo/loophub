#!/usr/bin/env bun
import { workerLog } from "./logger.ts";
// `lh-dispatcher` is the event-to-action resident process. The current workflow dispatcher is
// implemented by the existing runner; this entrypoint gives it an independent lifecycle while
// the job table protocol is introduced in a later migration.
import { startNotificationSweep, startWorkerHeartbeat } from "./maintenance.ts";
import {
  DEFAULT_DISPATCH_CONCURRENCY,
  normalizeDispatchConcurrency,
  startWorker,
} from "./runner.ts";

let pollMs = Number(process.env.LOOPHUB_POLL_MS ?? 1000);
if (!Number.isFinite(pollMs) || pollMs <= 0) pollMs = 1000;
let dispatchConcurrency = Number(
  process.env.LOOPHUB_DISPATCH_CONCURRENCY ?? DEFAULT_DISPATCH_CONCURRENCY,
);
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
  else if (argv[i] === "--dispatch-concurrency")
    dispatchConcurrency = Number(argv[++i]);
}
if (!Number.isFinite(pollMs) || pollMs <= 0) pollMs = 1000;
dispatchConcurrency = normalizeDispatchConcurrency(dispatchConcurrency);
const notificationSweepMs = Number(process.env.LOOPHUB_SWEEP_MS ?? 5000);
const dispatcher = startWorker({
  pollMs,
  concurrency: dispatchConcurrency,
});
const stopHeartbeat = startWorkerHeartbeat();
const stopNotifications =
  notificationSweepMs > 0
    ? startNotificationSweep(notificationSweepMs)
    : () => {};
workerLog.info(
  `lh-dispatcher started (events poll ${pollMs}ms; dispatch concurrency ${dispatchConcurrency}; notification sweep ${notificationSweepMs}ms)`,
);

let stopped = false;
const shutdown = () => {
  if (stopped) return;
  stopped = true;
  stopNotifications();
  stopHeartbeat();
  dispatcher.stop();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, shutdown);
