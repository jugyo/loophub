import { expect, test } from "vitest";
import { setInstanceSetting } from "../../core/store/instance-settings.ts";
import { isAllowedOrigin, isLoopbackHost } from "./net.ts";

test("isLoopbackHost recognizes loopback hostnames only", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
    expect(isLoopbackHost(h)).toBe(true);
  }
  for (const h of ["0.0.0.0", "example.com", "192.168.1.1", ""]) {
    expect(isLoopbackHost(h)).toBe(false);
  }
});

test("isAllowedOrigin allows absent/loopback origins and rejects cross-origin (CSWSH)", () => {
  // No Origin header: non-browser client (native ws / CLI) — allowed.
  expect(isAllowedOrigin(undefined)).toBe(true);

  expect(isAllowedOrigin("http://localhost:8730")).toBe(true);
  // Any loopback port is allowed, not just lh-web's own.
  expect(isAllowedOrigin("http://127.0.0.1:3000")).toBe(true);
  expect(isAllowedOrigin("http://[::1]:8730")).toBe(true);

  // Cross-origin browser requests are rejected.
  expect(isAllowedOrigin("https://evil.com")).toBe(false);
  expect(isAllowedOrigin("http://attacker.localhost.evil.com")).toBe(false);

  // Malformed Origin rejects rather than throws.
  expect(isAllowedOrigin("not a url")).toBe(false);
});

test("isAllowedOrigin allows only the configured public origin", () => {
  setInstanceSetting("public_origin", "https://loop.example.com");
  expect(isAllowedOrigin("https://loop.example.com")).toBe(true);
  expect(isAllowedOrigin("https://other.example.com")).toBe(false);
  setInstanceSetting("public_origin", "");
});
