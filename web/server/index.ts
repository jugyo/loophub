// `lh-web` entry point: start the lh-web HTTP process. Runs only while in use (no daemon).
//   lh-web [--port <n>]   (default 8730, or LOOPHUB_PORT)
import { createLhWebServer } from "./http.ts";

const argv = process.argv.slice(2);
let port = Number(process.env.LOOPHUB_PORT ?? 8730);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") port = Number(argv[++i]);
}

const server = createLhWebServer();
server.listen(port, () => {
  console.error(`lh-web listening on http://localhost:${port}  (POST /rpc, GET /events)`);
});
