// lh-web HTTP binding. A plain node:http server that mounts the JSON-RPC dispatcher at
// POST /rpc, streams events at GET /events (SSE), and serves the built SPA for everything
// else. There is no long-running daemon equivalent to the old `lh serve` / Bun.serve — the
// process runs only while someone is looking (dev: Vite proxies here; prod: serves web/dist).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchRaw } from "./rpc.ts";
import { subscribeEvents } from "./events.ts";

// Built SPA assets. Defaults to web/dist; override with LOOPHUB_WEB_DIST.
const DIST_DIR =
  process.env.LOOPHUB_WEB_DIST ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const SSE_HEARTBEAT_MS = 15_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 && CONTENT_TYPES[path.slice(dot)]) || "application/octet-stream";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const response = await dispatchRaw(body);
  if (response === null) {
    res.writeHead(204).end(); // all notifications -> no content
    return;
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(response));
}

function handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const since = Number(url.searchParams.get("since") || 0);
  const repo = url.searchParams.get("repo");

  let closed = false;
  const push = (s: string) => {
    if (!closed) res.write(s);
  };

  // Deliver each notification as an SSE `loophub` frame carrying the JSON-RPC notification.
  const unsub = subscribeEvents({ since, repo }, (n) => push(`event: loophub\ndata: ${JSON.stringify(n)}\n\n`));

  const heartbeat = setInterval(() => push(": heartbeat\n\n"), SSE_HEARTBEAT_MS);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsub();
    clearInterval(heartbeat);
    res.end();
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
}

// Serve a file from web/dist, falling back to index.html for SPA client routes.
function handleStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not built. Run the SPA build, or use the Vite dev server.\n");
    return;
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(DIST_DIR, rel);
  // Guard against path traversal escaping the dist root.
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST_DIR, "index.html"); // SPA fallback
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": contentType(filePath) });
  createReadStream(filePath).pipe(res);
}

export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/rpc" && req.method === "POST") {
    handleRpc(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
    });
    return;
  }
  if (url.pathname === "/events" && req.method === "GET") {
    handleEvents(req, res, url);
    return;
  }
  if (req.method === "GET") {
    handleStatic(req, res, url);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found\n");
}

export function createLhWebServer(): Server {
  return createServer(handleRequest);
}
