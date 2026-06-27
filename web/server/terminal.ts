// WebSocket <-> PTY bridge for the embedded terminal. The existing /events SSE feed is
// one-way; an interactive shell needs a bidirectional channel, so this attaches a WebSocket
// server to the same node:http server via the HTTP `upgrade` event (no second port).
//
// One connection == one PTY (core/pty.ts). The session lifecycle is tied to the socket:
// a dropped connection (reload, tab close, or a navigation that unmounts the view) kills the
// PTY, so shells never leak. Multiple terminals later (tab feature) are just more sockets.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { isServiceError } from "../../core/errors.ts";
import {
  createPtySession,
  type PtySession,
  resolveTerminalCwd,
} from "../../core/pty.ts";

const TERMINAL_PATH = "/terminal";

// Loopback hostnames. The terminal is a real shell, so we only ever trust connections that
// stay on the local host — both for the bind address (index.ts) and the WebSocket Origin.
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

// Browser WebSocket connections are NOT constrained by the same-origin policy: a page the user
// merely visits could open ws://localhost:PORT/terminal and obtain a shell (Cross-Site WebSocket
// Hijacking / drive-by RCE). Reject any cross-origin browser connection by checking the Origin
// header against loopback hosts. An absent Origin means a non-browser client (native ws / the
// CLI), which is allowed. Checking the Origin *hostname* (not the resolved IP) also defeats
// DNS rebinding, since the Origin keeps the attacker's hostname.
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false; // malformed Origin → reject
  }
}

// Short, non-sensitive WebSocket close reasons. Never forward internal error messages: they can
// embed the client-controlled repo name or the absolute local_path (info leak + enumeration
// oracle), and an over-123-byte reason makes `ws` throw inside the upgrade callback (DoS).
export function closeReasonFor(status: number): string {
  if (status === 404) return "repo not found";
  if (status === 422) return "repo base dir unavailable";
  return "terminal unavailable";
}

// Client -> server control frames (JSON). Server -> client output flows as raw text frames
// that xterm.js writes verbatim, so there is no envelope on the output path.
type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

// Attach the terminal WebSocket endpoint to an existing server. Returns a stop function.
export function attachTerminalServer(server: Server): () => void {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only claim /terminal upgrades. Other upgrades (Vite HMR's 'vite-hmr' socket) are left
    // for their own handler — do NOT destroy the socket here.
    if (url.pathname !== TERMINAL_PATH) return;
    // Reject cross-origin browser connections (CSWSH). This is our /terminal upgrade now, so
    // destroying the socket on a bad Origin is safe — no other handler wants it.
    if (!isAllowedOrigin(req.headers.origin)) {
      // end() flushes the 403 then sends FIN, so the response isn't truncated by an
      // immediate destroy(); closing the connection is what actually blocks the upgrade.
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const repo = url.searchParams.get("repo") ?? "";
      const cols = Number(url.searchParams.get("cols")) || undefined;
      const rows = Number(url.searchParams.get("rows")) || undefined;
      handleConnection(ws, repo, cols, rows);
    });
  };

  server.on("upgrade", onUpgrade);
  return () => {
    server.off("upgrade", onUpgrade);
    // Close sockets first so their 'close' handlers kill the PTYs, then the server.
    for (const ws of wss.clients) ws.close(1001, "server shutting down");
    wss.close();
  };
}

function handleConnection(
  ws: WebSocket,
  repo: string,
  cols?: number,
  rows?: number,
): void {
  let cwd: string;
  try {
    cwd = resolveTerminalCwd(repo);
  } catch (err) {
    // 4000-range: application-defined WebSocket close codes. Send a short, generic reason; the
    // detailed message (which can embed local_path) stays server-side only.
    const status = isServiceError(err) ? err.status : 500;
    ws.close(4004, closeReasonFor(status));
    return;
  }

  let session: PtySession;
  try {
    session = createPtySession({ cwd, cols, rows });
  } catch {
    ws.close(4500, "failed to spawn shell");
    return;
  }

  session.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
  session.onExit(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "shell exited");
  });

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }
    // Validate field shapes before dispatch: a valid-JSON frame with a wrong-typed/absent field
    // (e.g. {"type":"input"} → write(undefined)) would otherwise throw synchronously here and
    // escape as an uncaught exception, taking the process down.
    if (msg.type === "input" && typeof msg.data === "string") {
      session.write(msg.data);
    } else if (
      msg.type === "resize" &&
      Number.isFinite(msg.cols) &&
      Number.isFinite(msg.rows)
    ) {
      session.resize(msg.cols, msg.rows);
    }
  });

  // Any socket teardown kills the PTY — this is what prevents process leaks on reload.
  ws.on("close", () => session.kill());
  ws.on("error", () => session.kill());
}
