// `lh-web` entry point: start the lh-web HTTP process. Runs only while in use (no daemon).
//   lh-web [--port <n>] [--debug]
//   (port: default 8730 or LOOPHUB_PORT)
// One command, one port: this process serves the JSON-RPC API and the SPA
// (with HMR) by embedding Vite in middleware mode — no separate dev server. Resident
// maintenance loops run in lh-worker.

import { configureSlowOperationLogging } from "../../core/slow-operation.ts";
import { LH_WEB_HELP, type LhWebArgs, parseLhWebArgs } from "./args.ts";
import { createViteDev, type ViteDev } from "./dev.ts";
import { createLhWebServer } from "./http.ts";
import { log } from "./logger.ts";
import { setWebRuntimeConfig } from "./runtime-config.ts";

let args: LhWebArgs;
try {
  args = parseLhWebArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n\n${LH_WEB_HELP}`,
  );
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

// Embed Vite so this single process serves the SPA with HMR alongside /rpc.
// `vite` is assigned before listen(), so by the time requests arrive it is always set; the
// guard only covers the brief async startup window.
let vite: ViteDev | undefined;
const server = createLhWebServer((req, res, url) => {
  if (vite) vite.serveStatic(req, res, url);
  else res.writeHead(503).end("lh-web is starting\n");
});

// Bind to loopback by default: the embedded Vite server transforms and serves web/ source, so
// it must not be reachable off-host. Override with LOOPHUB_HOST (e.g. 0.0.0.0) only when LAN
// access is intentional.
const host = process.env.LOOPHUB_HOST ?? "127.0.0.1";

try {
  vite = await createViteDev(server);
} catch (err) {
  log.error(
    "lh-web: failed to start the embedded Vite dev server. Are web deps installed (npm install)?",
  );
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}

server.listen(port, host, () => {
  const shown = host === "127.0.0.1" ? "localhost" : host;
  log.info(`lh-web listening on http://${shown}:${port}  (API + UI + HMR)`);
});

let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  if (vite) await vite.close();

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
