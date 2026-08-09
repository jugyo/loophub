#!/usr/bin/env -S node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx
// `lh-web` entry point: start the lh-web HTTP process. Runs only while in use (no daemon).
//   lh-web [--port <n>] [--debug]
//   (port: default 8730 or LOOPHUB_PORT)
// One command, one port: this process serves the JSON-RPC API and the SPA it builds at startup
// (build.ts) — no dev server and no HMR, so a source change reaches the browser on the next
// restart. Resident maintenance loops run in lh-worker, including Notification Center generation (#118): without
// lh-worker running, lh-web alone will not produce new notifications.

import { configureSlowOperationLogging } from "../../core/slow-operation.ts";
import { LH_WEB_HELP, type LhWebArgs, parseLhWebArgs } from "./args.ts";
import { buildSpa } from "./build.ts";
import { createLhWebServer, handleStatic } from "./http.ts";
import { log } from "./logger.ts";
import { setWebRuntimeConfig } from "./runtime-config.ts";

let args: LhWebArgs;
try {
  args = parseLhWebArgs(process.argv.slice(2));
} catch (error) {
  log.error(error instanceof Error ? error.message : String(error));
  process.stderr.write(`\n${LH_WEB_HELP}`);
  process.exit(1);
}
if (args.help) {
  process.stdout.write(LH_WEB_HELP);
  process.exit(0);
}
const { port } = args;
setWebRuntimeConfig({
  debug: args.debug,
});
configureSlowOperationLogging(args.debug ? log.info : undefined);

// The build below takes a few seconds. Until it lands, refuse to serve rather than hand out
// whatever an earlier run left in web/dist — stale code is harder to notice than a plain error.
let built = false;
const server = createLhWebServer(
  (req, res, url) => {
    if (built) handleStatic(req, res, url);
    else res.writeHead(503).end("lh-web is building the UI\n");
  },
  { debug: args.debug },
);

// Bind to loopback by default: this is a single-user local tool and the API it exposes is
// unauthenticated. Override with LOOPHUB_HOST (e.g. 0.0.0.0) only when LAN access is intentional.
const host = process.env.LOOPHUB_HOST ?? "127.0.0.1";

server.on("error", (error) => {
  log.error(
    `lh-web: server error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});

// Listen first so a port clash is reported at once instead of after the build.
server.listen(port, host, () => {
  const shown = host === "127.0.0.1" ? "localhost" : host;
  const url = `http://${shown}:${port}`;
  log.info(`lh-web listening on ${url}  (API + UI)`);
});

try {
  await buildSpa();
  built = true;
  log.info("lh-web: SPA build ready");
} catch (err) {
  log.error(
    "lh-web: failed to build the SPA. Are web deps installed (npm --prefix web install)?",
  );
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}

let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Close gracefully first, giving existing connections a moment to finish.
  await new Promise<void>((resolve) => {
    server.close(() => {});
    // Force close any remaining connections after 100ms to prevent hanging.
    setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 100);
  });

  process.exit(0);
};

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdown().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`shutdown error: ${msg}`);
      process.exit(1);
    });
  });
}
