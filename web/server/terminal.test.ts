import { expect, test } from "vitest";
import { closeReasonFor, isAllowedOrigin, isLoopbackHost } from "./terminal.ts";

test("isLoopbackHost recognizes loopback hostnames only", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
    expect(isLoopbackHost(h)).toBe(true);
  }
  for (const h of ["0.0.0.0", "192.168.1.10", "example.com", "127.0.0.2"]) {
    expect(isLoopbackHost(h)).toBe(false);
  }
});

test("isAllowedOrigin allows absent/loopback origins and rejects cross-origin (CSWSH)", () => {
  // Native ws / CLI clients send no Origin.
  expect(isAllowedOrigin(undefined)).toBe(true);
  // Same-host browser origins (any port) — server, Vite dev proxy, IPv6 loopback.
  expect(isAllowedOrigin("http://localhost:8730")).toBe(true);
  expect(isAllowedOrigin("http://127.0.0.1:5173")).toBe(true);
  expect(isAllowedOrigin("http://[::1]:8730")).toBe(true);
  // A page the user merely visits must not open the terminal — including DNS-rebinding,
  // where the Origin keeps the attacker hostname even if it resolves to 127.0.0.1.
  expect(isAllowedOrigin("https://evil.com")).toBe(false);
  expect(isAllowedOrigin("http://attacker.localhost.evil.com")).toBe(false);
  // Malformed Origin → reject.
  expect(isAllowedOrigin("not a url")).toBe(false);
});

test("closeReasonFor returns short, non-sensitive reasons", () => {
  expect(closeReasonFor(404)).toBe("repo not found");
  expect(closeReasonFor(422)).toBe("repo base dir unavailable");
  expect(closeReasonFor(500)).toBe("terminal unavailable");
  // Every reason stays well under the ws 123-byte close-reason limit.
  for (const s of [404, 422, 500]) {
    expect(Buffer.byteLength(closeReasonFor(s), "utf8")).toBeLessThanOrEqual(
      123,
    );
  }
});
