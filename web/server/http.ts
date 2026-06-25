// lh-web HTTP binding. A plain node:http server that mounts the JSON-RPC dispatcher at
// POST /rpc, streams events at GET /events (SSE), and delegates everything else to a static
// handler for the SPA. There is no long-running daemon equivalent to the old `lh serve` /
// Bun.serve — the process runs only while someone is looking. The SPA handler is injectable:
// `lh-web` injects a Vite dev middleware (dev.ts) so one process serves the UI with HMR; the
// default `handleStatic` serves a built web/dist. Keeping Vite out of this file means the
// RPC/SSE core (and its tests) never import Vite.

import { createReadStream, existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  blobPath,
  getAttachment,
  MAX_ATTACHMENT_BYTES,
  saveAttachment,
} from "../../core/attachments.ts";
import { isServiceError } from "../../core/errors.ts";
import { subscribeEvents } from "./events.ts";
import { dispatchRaw } from "./rpc.ts";

// Built SPA assets. Defaults to web/dist; override with LOOPHUB_WEB_DIST.
const DIST_DIR =
  process.env.LOOPHUB_WEB_DIST ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
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
  return (
    (dot >= 0 && CONTENT_TYPES[path.slice(dot)]) || "application/octet-stream"
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Read a request body as binary. Once it exceeds `limit` we stop buffering (so
// memory stays bounded to ~limit) but keep draining the stream, then report it as
// `tooLarge` — that lets the handler reply with a clean 413 instead of resetting
// the socket. (LoopHub is a local single-user tool, so draining an oversized body
// is acceptable; the hard size check is also enforced in saveAttachment.)
function readBinaryBody(
  req: IncomingMessage,
  limit: number,
): Promise<{ data: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      total += (c as Buffer).length;
      if (total > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(c as Buffer);
    });
    req.on("end", () => resolve({ data: Buffer.concat(chunks), tooLarge }));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// POST /attachments — upload a standalone image blob. The binary is the request
// body; `filename` and `actor` come from the query string (or x-filename /
// x-actor headers), MIME from content-type. Returns the stored metadata plus the
// embed `url` and `markdown`.
async function handleAttachmentUpload(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  let data: Buffer;
  try {
    const body = await readBinaryBody(req, MAX_ATTACHMENT_BYTES);
    if (body.tooLarge) {
      sendJson(res, 413, { error: "Image too large (max 10MB)" });
      return;
    }
    data = body.data;
  } catch {
    sendJson(res, 400, { error: "Failed to read request body" });
    return;
  }
  const filename =
    url.searchParams.get("filename") ||
    (req.headers["x-filename"] as string) ||
    "";
  if (!filename) {
    sendJson(res, 400, { error: "filename is required" });
    return;
  }
  const author =
    url.searchParams.get("actor") ||
    (req.headers["x-actor"] as string) ||
    "unknown";
  const mime = (req.headers["content-type"] as string) || null;
  try {
    const result = saveAttachment({ data, filename, mime, author });
    sendJson(res, 201, result);
  } catch (e) {
    if (isServiceError(e)) sendJson(res, e.status, { error: e.message });
    else sendJson(res, 500, { error: "Internal error" });
  }
}

// GET /attachments/:sha256 — stream a stored blob with its recorded content-type.
function handleAttachmentGet(res: ServerResponse, url: URL): void {
  const sha256 = url.pathname.slice("/attachments/".length);
  // sha256 is a fixed 64-char hex string; rejecting anything else also blocks
  // path traversal before the value reaches blobPath().
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    res.writeHead(404).end();
    return;
  }
  const att = getAttachment(sha256);
  const path = blobPath(sha256);
  if (!att || !existsSync(path)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": att.mime,
    "cache-control": "public, max-age=31536000, immutable",
    // Bytes aren't magic-byte-validated, so stop the browser from sniffing a
    // served blob into something other than its recorded image content-type.
    "x-content-type-options": "nosniff",
  });
  const stream = createReadStream(path);
  // Guard the TOCTOU race (blob removed between existsSync and open): a stream
  // error here would otherwise be unhandled and crash the process.
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  });
  stream.pipe(res);
}

async function handleRpc(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  const response = await dispatchRaw(body);
  if (response === null) {
    res.writeHead(204).end(); // all notifications -> no content
    return;
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(response));
}

function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
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
  const unsub = subscribeEvents({ since, repo }, (n) =>
    push(`event: loophub\ndata: ${JSON.stringify(n)}\n\n`),
  );

  const heartbeat = setInterval(
    () => push(": heartbeat\n\n"),
    SSE_HEARTBEAT_MS,
  );

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
function handleStatic(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not built. Run the SPA build, or use the Vite dev server.\n");
    return;
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(
    /^(\.\.[/\\])+/,
    "",
  );
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

// Serves GET requests that aren't /rpc or /events — i.e. the SPA. `handleStatic` (web/dist)
// is the default; `lh-web` injects a Vite dev middleware instead (see dev.ts).
export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => void;

export function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  serveStatic: StaticHandler,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/rpc" && req.method === "POST") {
    handleRpc(req, res).catch(() => {
      if (!res.headersSent)
        res.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
        });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error" },
        }),
      );
    });
    return;
  }
  if (url.pathname === "/events" && req.method === "GET") {
    handleEvents(req, res, url);
    return;
  }
  if (url.pathname === "/attachments" && req.method === "POST") {
    handleAttachmentUpload(req, res, url).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
    });
    return;
  }
  if (url.pathname.startsWith("/attachments/") && req.method === "GET") {
    handleAttachmentGet(res, url);
    return;
  }
  if (req.method === "GET") {
    serveStatic(req, res, url);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found\n");
}

export function createLhWebServer(
  serveStatic: StaticHandler = handleStatic,
): Server {
  return createServer((req, res) => handleRequest(req, res, serveStatic));
}
