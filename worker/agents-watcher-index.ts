#!/usr/bin/env -S node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx
import { workerLog } from "./logger.ts";
// `lh-watcher-agents` owns observations obtained from the agent runtime. It persists snapshots and
// usage facts; agent control remains outside this observer process.
import {
  DEFAULT_HERDR_SWEEP_MS,
  DEFAULT_USAGE_SWEEP_MS,
  startHerdrSnapshotSweep,
  startUsageSweep,
} from "./maintenance.ts";

const argv = process.argv.slice(2);
let herdrSweepMs = Number(
  process.env.LOOPHUB_HERDR_SWEEP_MS ?? DEFAULT_HERDR_SWEEP_MS,
);
let usageSweepMs = Number(
  process.env.LOOPHUB_USAGE_SWEEP_MS ?? DEFAULT_USAGE_SWEEP_MS,
);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--herdr-sweep-ms") herdrSweepMs = Number(argv[++i]);
  else if (argv[i] === "--usage-sweep-ms") usageSweepMs = Number(argv[++i]);
}

const stops = [
  herdrSweepMs > 0 ? startHerdrSnapshotSweep(herdrSweepMs) : () => {},
  usageSweepMs > 0 ? startUsageSweep(usageSweepMs) : () => {},
];
const keepAlive = setInterval(() => {}, 60_000);
workerLog.info(
  `lh-watcher-agents started (herdr sweep ${herdrSweepMs}ms; usage sweep ${usageSweepMs}ms)`,
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
