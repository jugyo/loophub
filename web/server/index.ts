// `lh-web` entry point: start the lh-web HTTP process. Runs only while in use (no daemon).
//   lh-web [--port <n>] [--poll-ms <ms>]   (port: default 8730 or LOOPHUB_PORT)
import { createLhWebServer } from "./http.ts";
import { startEventTail } from "./events.ts";

const argv = process.argv.slice(2);
let port = Number(process.env.LOOPHUB_PORT ?? 8730);
let pollMs = Number(process.env.LOOPHUB_POLL_MS ?? 1000);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") port = Number(argv[++i]);
  else if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
}

// Tail the shared DB so CLI/agent (out-of-process) writes reach SSE subscribers live.
const stopTail = startEventTail(pollMs);

const server = createLhWebServer();
server.listen(port, () => {
  console.error(
    `lh-web listening on http://localhost:${port}  (POST /rpc, GET /events; events poll ${pollMs}ms)`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopTail();
    server.close(() => process.exit(0));
  });
}
