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
