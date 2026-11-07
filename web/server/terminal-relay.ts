// Relays one browser WebSocket to `hc attach <terminal>` on a PTY (#2574). The attach belongs to the
// socket; the terminal belongs to the herdr-core server, so closing the socket or stopping lh-web
// ends only the attach and the agent keeps running.

import { isServiceError } from "../../core/errors.ts";
import { herdrCoreEnv } from "../../core/herdr-core.ts";
import { terminal } from "../../core/service.ts";
import { isAllowedOrigin, isCrossSiteFetch, isLoopbackRequest } from "./net.ts";

export const TERMINAL_RELAY_PATH = "/ws/terminal";

export interface TerminalRelayData {
  address: string;
  cols: number;
  rows: number;
  attach?: Bun.Subprocess;
}

function terminalSize(raw: string | null, fallback: number): number {
  const size = Number(raw);
  return Number.isInteger(size) && size > 0 && size <= 1000 ? size : fallback;
}

// Same Origin rules as POST /rpc, then loopback only: a terminal takes input, so unlike the RPC API
// it stays off public_origin and off a non-loopback bind.
export async function handleTerminalUpgrade(
  req: Request,
  server: Bun.Server<TerminalRelayData>,
): Promise<Response | undefined> {
  if (
    isCrossSiteFetch(req) ||
    !isAllowedOrigin(req.headers.get("origin") ?? undefined) ||
    !isLoopbackRequest(req, server.requestIP(req)?.address)
  )
    return new Response("Forbidden\n", { status: 403 });
  const url = new URL(req.url);
  const address = url.searchParams.get("terminal") ?? "";
  const repo = url.searchParams.get("repo") ?? "";
  // No PR means a New issue terminal: it runs before its issue exists, so it has no PR.
  const pull = url.searchParams.get("pull");
  try {
    await (pull === null
      ? terminal.assertIssueTerminalAttachable({ repo, address })
      : terminal.assertPullTerminalAttachable({
          repo,
          pull: Number(pull),
          address,
        }));
  } catch (error) {
    return isServiceError(error)
      ? new Response(`${error.message}\n`, { status: error.status })
      : new Response("Internal error\n", { status: 500 });
  }
  const upgraded = server.upgrade(req, {
    data: {
      address,
      cols: terminalSize(url.searchParams.get("cols"), 80),
      rows: terminalSize(url.searchParams.get("rows"), 24),
    },
  });
  return upgraded
    ? undefined
    : new Response("Upgrade Required\n", { status: 426 });
}

export const terminalRelayWebSocket: Bun.WebSocketHandler<TerminalRelayData> = {
  // A client too slow to keep up sees the connection close and can reconnect, rather than a screen
  // silently garbled by dropped frames.
  closeOnBackpressureLimit: true,
  open(ws) {
    try {
      const attach = Bun.spawn(["hc", "attach", ws.data.address], {
        // The browser runs xterm.js; lh-web's own TERM (or none) would describe the wrong terminal,
        // and `terminal.name` does not override an inherited TERM.
        env: { ...herdrCoreEnv(), TERM: "xterm-256color" },
        terminal: {
          name: "xterm-256color",
          cols: ws.data.cols,
          rows: ws.data.rows,
          data: (_terminal, data) => ws.send(data),
        },
      });
      ws.data.attach = attach;
      // The terminal finished, or hc refused the attach and said why on the PTY.
      void attach.exited.then(() => ws.close());
    } catch {
      ws.close(1011, "failed to launch hc");
    }
  },
  // Binary frames are keystrokes; a text frame is a resize, `{"cols":n,"rows":n}`.
  message(ws, message) {
    const pty = ws.data.attach?.terminal;
    if (!pty) return;
    if (typeof message !== "string") {
      pty.write(message);
      return;
    }
    try {
      const { cols, rows } = JSON.parse(message);
      ws.data.cols = terminalSize(String(cols), ws.data.cols);
      ws.data.rows = terminalSize(String(rows), ws.data.rows);
      pty.resize(ws.data.cols, ws.data.rows);
    } catch {
      // Not a resize: only this socket's own page writes here, so there is nothing to report to.
    }
  },
  close(ws) {
    ws.data.attach?.kill();
    ws.data.attach?.terminal?.close();
  },
};
