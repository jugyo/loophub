// Loopback/Origin helpers shared by the HTTP server. Split out of the old builtin-terminal
// WebSocket bridge (removed in #564) since http.ts's RPC CSRF defense depends on the same
// loopback/Origin logic independent of the terminal feature.

import { getInstanceSetting } from "../../core/store/instance-settings.ts";

// Loopback hostnames. Used both for the bind-address check (index.ts) and the RPC Origin check
// (http.ts) — anything that must only ever trust connections staying on the local host.
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

// A form can't set content-type: application/json without a CORS preflight, so http.ts's JSON check
// already defeats classic non-preflighted CSRF. This catches the modern-browser case on top: a page's
// cross-site fetch() carries Sec-Fetch-Site: cross-site regardless of content-type.
export function isCrossSiteFetch(req: Request): boolean {
  return req.headers.get("sec-fetch-site") === "cross-site";
}

// Whether a request stayed on this machine, for what must not be reachable remotely even from an
// allowed origin. A tunnel behind public_origin connects from loopback, so the peer address is not
// enough: Host and Origin name where the browser really is, and a proxy marks what it forwards.
// Origin must be this very server: a WebSocket has no CORS preflight, so unlike POST /rpc nothing
// else stops a page on another localhost port.
export function isLoopbackRequest(
  req: Request,
  peerAddress: string | undefined,
): boolean {
  if (
    !peerAddress ||
    !isLoopbackHost(peerAddress.replace(/^::ffff:/, "")) ||
    req.headers.has("x-forwarded-for") ||
    req.headers.has("forwarded")
  )
    return false;
  try {
    const origin = req.headers.get("origin");
    const host = new URL(`http://${req.headers.get("host")}`);
    return (
      isLoopbackHost(host.hostname) &&
      (!origin || new URL(origin).host === host.host)
    );
  } catch {
    return false; // malformed Host or Origin
  }
}

// Browser fetch()/WebSocket requests are NOT constrained by the same-origin policy in every case
// a server might assume, so http.ts checks the Origin header against loopback hosts as part of
// its CSRF defense for POST /rpc. An absent Origin means a non-browser client (native fetch / the
// CLI), which is allowed. Checking the Origin *hostname* (not the resolved IP) also defeats DNS
// rebinding, since the Origin keeps the attacker's hostname.
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const configured = getInstanceSetting("public_origin");
    if (configured && origin === configured) return true;
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false; // malformed Origin → reject
  }
}
