// lh-web HTTP binding. A Bun.serve server that mounts the JSON-RPC dispatcher at
// POST /rpc, serves attachments, and delegates everything else to a static handler for the SPA.
// `handleStatic` serves the web/dist that `lh-web` builds at startup (build.ts); it stays
// injectable so the handler can be wrapped, as `lh-web` does while that build is still running.
// Keeping the build tool out of this file means the HTTP core (and its tests) never imports it.

import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import {
  blobPath,
  getAttachment,
  MAX_ATTACHMENT_BYTES,
  saveAttachment,
} from "../../core/attachments.ts";
import { isServiceError } from "../../core/errors.ts";
import { webDistDir } from "../../core/self-exec.ts";
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

// Built SPA assets: web/dist in this checkout, or the directory shipped beside the binary.
const DIST_DIR = webDistDir();
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
async function readBinaryBody(
  req: Request,
  limit: number,
): Promise<{ data: Buffer; tooLarge: boolean }> {
  const reader = req.body?.getReader();
  if (!reader) return { data: Buffer.alloc(0), tooLarge: false };

  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      tooLarge = true;
      continue;
    }
    chunks.push(value);
  }
  return { data: Buffer.concat(chunks), tooLarge };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
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

function isJsonRequest(req: Request): boolean {
  return (
    (req.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase() === "application/json"
  );
}

// A form can't set content-type: application/json without a CORS preflight, so the JSON check
// above already defeats classic non-preflighted CSRF. This catches the modern-browser case on top:
// a page's cross-site fetch() carries Sec-Fetch-Site: cross-site regardless of content-type.
function isCrossSiteFetch(req: Request): boolean {
  return req.headers.get("sec-fetch-site") === "cross-site";
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
  req: Request,
  url: URL,
): Promise<Response> {
  let data: Buffer;
  try {
    const body = await readBinaryBody(req, MAX_ATTACHMENT_BYTES);
    if (body.tooLarge) {
      return jsonResponse(413, { error: "Attachment too large (max 10MB)" });
    }
    data = body.data;
  } catch {
    return jsonResponse(400, { error: "Failed to read request body" });
  }
  const filename =
    url.searchParams.get("filename") || req.headers.get("x-filename") || "";
  if (!filename) {
    return jsonResponse(400, { error: "filename is required" });
  }
  const author =
    url.searchParams.get("actor") || req.headers.get("x-actor") || "unknown";
  const mime = req.headers.get("content-type");
  try {
    const result = await saveAttachment({ data, filename, mime, author });
    return jsonResponse(201, result);
  } catch (e) {
    if (isServiceError(e)) return jsonResponse(e.status, { error: e.message });
    return jsonResponse(500, { error: "Internal error" });
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
function handleAttachmentGet(url: URL): Response {
  const sha256 = url.pathname.slice("/attachments/".length);
  // sha256 is a fixed 64-char hex string; rejecting anything else also blocks
  // path traversal before the value reaches blobPath().
  if (!/^[0-9a-f]{64}$/.test(sha256))
    return new Response(null, { status: 404 });
  const att = getAttachment(sha256);
  const path = blobPath(sha256);
  if (!att || !existsSync(path)) return new Response(null, { status: 404 });
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
  return new Response(Bun.file(path), { status: 200, headers });
}

async function handleRpc(
  req: Request,
  receivedAt: bigint,
  rpcLogger?: RpcLogger,
): Promise<Response> {
  const body = await readBinaryBody(req, MAX_RPC_REQUEST_BYTES);
  if (body.tooLarge) {
    return jsonResponse(413, requestTooLarge(MAX_RPC_REQUEST_BYTES));
  }
  const calls: RpcCallOutcome[] = [];
  const response = await dispatchRaw(
    body.data.toString("utf8"),
    rpcLogger ? (call) => calls.push(call) : undefined,
    receivedAt,
  );
  if (response === null) {
    logRpcCalls(rpcLogger, calls);
    return new Response(null, { status: 204 }); // all notifications -> no content
  }
  let serialized = stringifyJsonWithinLimit(response, MAX_RPC_RESPONSE_BYTES);
  if (serialized === null) {
    const id = Array.isArray(response) ? null : (response as RpcResponse).id;
    serialized = JSON.stringify(responseTooLarge(id));
    logRpcCalls(rpcLogger, calls, true);
  } else {
    logRpcCalls(rpcLogger, calls);
  }
  return new Response(serialized, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Serve a file from web/dist, falling back to index.html for SPA client routes.
export function handleStatic(_req: Request, url: URL): Response {
  if (!existsSync(DIST_DIR)) {
    return new Response(
      "Not built. Start lh-web, which builds the SPA before serving it.\n",
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(
    /^(\.\.[/\\])+/,
    "",
  );
  let filePath = join(DIST_DIR, rel);
  // Guard against path traversal escaping the dist root.
  if (!filePath.startsWith(DIST_DIR))
    return new Response(null, { status: 403 });
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST_DIR, "index.html"); // SPA fallback
  }
  if (!existsSync(filePath)) return new Response(null, { status: 404 });
  return new Response(Bun.file(filePath), {
    status: 200,
    headers: { "content-type": contentType(filePath) },
  });
}

// Serves GET requests that aren't API routes — i.e. the SPA. `handleStatic` (web/dist) is the
// default; `lh-web` wraps it so requests that arrive while its startup build is still running
// get an error instead of the previous build.
export type StaticHandler = (
  req: Request,
  url: URL,
) => Response | Promise<Response>;

export async function handleRequest(
  req: Request,
  serveStatic: StaticHandler,
  rpcLogger?: RpcLogger,
): Promise<Response> {
  // Captured as early as possible so queue_ms covers time this request spent waiting
  // behind other work on the event loop, not just this handler's own processing.
  const receivedAt = process.hrtime.bigint();
  const url = new URL(req.url);
  if (url.pathname === "/rpc" && req.method === "POST") {
    if (!isJsonRequest(req)) {
      return jsonResponse(415, { error: "Unsupported Media Type" });
    }
    if (
      isCrossSiteFetch(req) ||
      (isBoundToLoopback() &&
        !isAllowedOrigin(req.headers.get("origin") ?? undefined))
    ) {
      return jsonResponse(403, { error: "Forbidden" });
    }
    try {
      return await handleRpc(req, receivedAt, rpcLogger);
    } catch {
      return jsonResponse(500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal error" },
      });
    }
  }
  if (url.pathname === "/events" && req.method === "GET") {
    return new Response("Gone\n", {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (url.pathname === "/attachments" && req.method === "POST") {
    try {
      return await handleAttachmentUpload(req, url);
    } catch {
      return jsonResponse(500, { error: "Internal error" });
    }
  }
  if (url.pathname.startsWith("/attachments/") && req.method === "GET") {
    return handleAttachmentGet(url);
  }
  if (req.method === "GET") return serveStatic(req, url);
  return new Response("Not Found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function createLhWebServer(
  serveStatic: StaticHandler = handleStatic,
  options: {
    debug?: boolean;
    logger?: RpcLogger;
    port?: number;
    hostname?: string;
  } = {},
): ReturnType<typeof Bun.serve> {
  const rpcLogger = options.debug ? (options.logger ?? log.info) : undefined;
  return Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    fetch: (req) => handleRequest(req, serveStatic, rpcLogger),
  });
}
