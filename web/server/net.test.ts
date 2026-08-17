import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before net.ts -> instance-settings.ts -> db.ts.
const HOME = mkdtempSync(join(tmpdir(), "lh-net-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let setInstanceSetting: typeof import("../../core/store/instance-settings.ts").setInstanceSetting;
let isAllowedOrigin: typeof import("./net.ts").isAllowedOrigin;
let isLoopbackHost: typeof import("./net.ts").isLoopbackHost;

beforeAll(async () => {
  ({ setInstanceSetting } = await import(
    "../../core/store/instance-settings.ts"
  ));
  ({ isAllowedOrigin, isLoopbackHost } = await import("./net.ts"));
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

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
