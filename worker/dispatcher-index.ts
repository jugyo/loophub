#!/usr/bin/env bun
import { workerLog } from "./logger.ts";
// `lh-dispatcher` is the event-to-action resident process. The current workflow dispatcher is
// implemented by the existing runner; this entrypoint gives it an independent lifecycle while
// the job table protocol is introduced in a later migration.
import { startNotificationSweep, startWorkerHeartbeat } from "./maintenance.ts";
import { startWorker } from "./runner.ts";

let pollMs = Number(process.env.LOOPHUB_POLL_MS ?? 1000);
if (!Number.isFinite(pollMs) || pollMs <= 0) pollMs = 1000;
const notificationSweepMs = Number(process.env.LOOPHUB_SWEEP_MS ?? 5000);
const dispatcher = startWorker({ pollMs });
const stopHeartbeat = startWorkerHeartbeat();
const stopNotifications =
  notificationSweepMs > 0
    ? startNotificationSweep(notificationSweepMs)
    : () => {};
workerLog.info(
  `lh-dispatcher started (events poll ${pollMs}ms; notification sweep ${notificationSweepMs}ms)`,
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
