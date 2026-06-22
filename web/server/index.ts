// `lh-web` entry point: start the lh-web HTTP process. Runs only while in use (no daemon).
//   lh-web [--port <n>] [--poll-ms <ms>] [--sweep-ms <ms>]   (port: default 8730 or LOOPHUB_PORT)
// One command, one port: this process serves the JSON-RPC API, the SSE feed, AND the SPA
// (with HMR) by embedding Vite in middleware mode — no separate dev server.
import { createLhWebServer } from "./http.ts";
import { createViteDev, type ViteDev } from "./dev.ts";
import { DEFAULT_SWEEP_MS, startEventTail, startPullSweep } from "./events.ts";

const argv = process.argv.slice(2);
let port = Number(process.env.LOOPHUB_PORT ?? 8730);
let pollMs = Number(process.env.LOOPHUB_POLL_MS ?? 1000);
let sweepMs = Number(process.env.LOOPHUB_SWEEP_MS ?? DEFAULT_SWEEP_MS);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") port = Number(argv[++i]);
  else if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
  else if (argv[i] === "--sweep-ms") sweepMs = Number(argv[++i]);
}

// A non-numeric env/flag (or a trailing `--sweep-ms` with no value) yields NaN; since `NaN > 0`
// is false that would silently disable the sweep — the exact stall this feature prevents. Fall
// back to the default instead of going quiet.
if (!Number.isFinite(sweepMs)) sweepMs = DEFAULT_SWEEP_MS;

// Tail the shared DB so CLI/agent (out-of-process) writes reach SSE subscribers live.
const stopTail = startEventTail(pollMs);
// Auto-fire pull_request.updated from open PR head SHA changes (no `lh sync` needed).
// sweepMs <= 0 disables the resident sweep (rely on manual `lh sync` / `sync/run`).
const stopSweep = sweepMs > 0 ? startPullSweep(sweepMs) : () => {};

// Embed Vite so this single process serves the SPA with HMR alongside /rpc and /events.
// `vite` is assigned before listen(), so by the time requests arrive it is always set; the
// guard only covers the brief async startup window.
let vite: ViteDev | undefined;
const server = createLhWebServer((req, res, url) => {
  if (vite) vite.serveStatic(req, res, url);
  else res.writeHead(503).end("lh-web is starting\n");
});
try {
  vite = await createViteDev(server);
} catch (err) {
  stopTail();
  stopSweep();
  console.error("lh-web: failed to start the embedded Vite dev server. Are web deps installed (npm install)?");
  console.error(err);
  process.exit(1);
}

// Bind to loopback by default: the embedded Vite server transforms and serves web/ source,
// so it must not be reachable off-host. Override with LOOPHUB_HOST (e.g. 0.0.0.0) only when
// LAN access is intentional.
const host = process.env.LOOPHUB_HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  const shown = host === "127.0.0.1" ? "localhost" : host;
  console.error(
    `lh-web listening on http://${shown}:${port}  (API + UI + HMR; events poll ${pollMs}ms; PR sweep ${sweepMs > 0 ? `${sweepMs}ms` : "off"})`,
  );
});

let isShuttingDown = false;

const shutdown = async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  stopTail();
  stopSweep();
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
      console.error(`shutdown error: ${msg}`);
      process.exit(1);
    });
  });
}
