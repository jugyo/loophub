// lh-web HTTP binding. A plain node:http server that mounts the JSON-RPC dispatcher at
// POST /rpc, serves attachments, and delegates everything else to a static handler for the SPA.
// There is no long-running daemon equivalent to the old `lh serve` /
// Bun.serve — the process runs only while someone is looking. `handleStatic` serves the web/dist
// that `lh-web` builds at startup (build.ts); it stays injectable so the handler can be wrapped,
// as `lh-web` does while that build is still running. Keeping Vite out of this file means the
// HTTP core (and its tests) never imports Vite.

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
import { stringifyJsonWithinLimit } from "./bounded-json.ts";
import { log } from "./logger.ts";
import { isAllowedOrigin, isLoopbackHost } from "./net.ts";
import {
  dispatchRaw,
  type RpcCallOutcome,
  type RpcResponse,
  requestTooLarge,
  responseTooLarge,
} from "./rpc.ts";

// Built SPA assets. Defaults to web/dist; override with LOOPHUB_WEB_DIST.
const DIST_DIR =
  process.env.LOOPHUB_WEB_DIST ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
export const MAX_RPC_REQUEST_BYTES = 1024 * 1024;
export const MAX_RPC_RESPONSE_BYTES = 10 * 1024 * 1024;
type RpcLogger = (message: string) => void;

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

function logRpcCalls(
  logger: RpcLogger | undefined,
  calls: RpcCallOutcome[],
  forceError = false,
): void {
  if (!logger) return;
  for (const call of calls) {
    const outcome = forceError ? "error" : call.outcome;
    const batch =
      call.batchIndex === undefined ? "" : ` batch_index=${call.batchIndex}`;
    logger(
      `rpc method=${JSON.stringify(call.method)} outcome=${outcome} queue_ms=${call.queueMs.toFixed(2)} handler_ms=${call.handlerMs.toFixed(2)}${batch}`,
    );
  }
}

function isJsonRequest(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return (
    (value ?? "").split(";")[0].trim().toLowerCase() === "application/json"
  );
}

// A form can't set content-type: application/json without a CORS preflight, so the JSON check
// above already defeats classic non-preflighted CSRF. This catches the modern-browser case on top:
// a page's cross-site fetch() carries Sec-Fetch-Site: cross-site regardless of content-type.
function isCrossSiteFetch(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === "cross-site";
}

// Sec-Fetch-Site alone doesn't stop DNS rebinding: an attacker's page (origin evil.com) can wait
// for evil.com's DNS to rebind to 127.0.0.1/the LAN host, then fetch("http://evil.com:<port>/rpc")
// — that request is same-origin from the browser's point of view (Sec-Fetch-Site: same-origin), so
// it reaches this far, but its actual Origin header string is still "evil.com", never "localhost"
// (rebinding only changes DNS resolution, not what the page's own JS sends). Checking the Origin
// *hostname* against loopback names (isAllowedOrigin, net.ts) defeats that. But it must not reject
// the SPA's own same-origin requests when the operator has intentionally bound lh-web off loopback
// (LOOPHUB_HOST=0.0.0.0 etc., #465) — those legitimately carry a non-loopback Origin. So apply the
// strict loopback check only while still bound to loopback (the default, overwhelmingly common
// case); an operator who opts into a non-loopback bind has already accepted broadened exposure for
// this instance.
function isBoundToLoopback(): boolean {
  return isLoopbackHost(process.env.LOOPHUB_HOST ?? "127.0.0.1");
}

// POST /attachments — upload a standalone attachment blob. The binary is the request
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
      sendJson(res, 413, { error: "Attachment too large (max 10MB)" });
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

function safeDownloadFilename(filename: string): string {
  const leaf = filename.replaceAll("\\", "/").split("/").pop() || "";
  return (
    leaf
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .trim() || "attachment"
  );
}

// Document attachments (`.md` / `.txt`) are served as UTF-8 plain text so that
// following the link from an issue body shows the document in the browser: a
// `text/markdown` response is downloaded rather than displayed, and a charset-less
// `text/plain` one is decoded with the browser's legacy default, which mangles
// non-ASCII text. text/html keeps its recorded type (and download disposition).
function inlineTextContentType(mime: string): string | null {
  return mime === "text/markdown" || mime === "text/plain"
    ? "text/plain; charset=utf-8"
    : null;
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
  const headers: Record<string, string> = {
    "content-type": inlineTextContentType(att.mime) ?? att.mime,
    "cache-control": "public, max-age=31536000, immutable",
    // Bytes aren't magic-byte-validated, so stop the browser from sniffing a
    // served blob into something other than its recorded content-type.
    "x-content-type-options": "nosniff",
  };
  if (att.mime === "text/html") {
    headers["content-disposition"] =
      `attachment; filename="${safeDownloadFilename(att.filename)}"`;
  }
  res.writeHead(200, headers);
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
  receivedAt: bigint,
  rpcLogger?: RpcLogger,
): Promise<void> {
  const body = await readBinaryBody(req, MAX_RPC_REQUEST_BYTES);
  if (body.tooLarge) {
    sendJson(res, 413, requestTooLarge(MAX_RPC_REQUEST_BYTES));
    return;
  }
  const calls: RpcCallOutcome[] = [];
  const response = await dispatchRaw(
    body.data.toString("utf8"),
    rpcLogger ? (call) => calls.push(call) : undefined,
    receivedAt,
  );
  if (response === null) {
    logRpcCalls(rpcLogger, calls);
    res.writeHead(204).end(); // all notifications -> no content
    return;
  }
  let serialized = stringifyJsonWithinLimit(response, MAX_RPC_RESPONSE_BYTES);
  if (serialized === null) {
    const id = Array.isArray(response) ? null : (response as RpcResponse).id;
    serialized = JSON.stringify(responseTooLarge(id));
    logRpcCalls(rpcLogger, calls, true);
  } else {
    logRpcCalls(rpcLogger, calls);
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(serialized);
}

// Serve a file from web/dist, falling back to index.html for SPA client routes.
export function handleStatic(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  if (!existsSync(DIST_DIR)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "Not built. Start lh-web, which builds the SPA before serving it.\n",
    );
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

// Serves GET requests that aren't API routes — i.e. the SPA. `handleStatic` (web/dist) is the
// default; `lh-web` wraps it so requests that arrive while its startup build is still running
// get an error instead of the previous build.
export type StaticHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => void;

export function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  serveStatic: StaticHandler,
  rpcLogger?: RpcLogger,
): void {
  // Captured as early as possible so queue_ms covers time this request spent waiting
  // behind other work on the event loop, not just this handler's own processing.
  const receivedAt = process.hrtime.bigint();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/rpc" && req.method === "POST") {
    if (!isJsonRequest(req)) {
      sendJson(res, 415, { error: "Unsupported Media Type" });
      return;
    }
    if (
      isCrossSiteFetch(req) ||
      (isBoundToLoopback() && !isAllowedOrigin(req.headers.origin))
    ) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    handleRpc(req, res, receivedAt, rpcLogger).catch(() => {
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
    res.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
    res.end("Gone\n");
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
  options: {
    debug?: boolean;
    logger?: RpcLogger;
  } = {},
): Server {
  const rpcLogger = options.debug ? (options.logger ?? log.info) : undefined;
  return createServer((req, res) =>
    handleRequest(req, res, serveStatic, rpcLogger),
  );
}
