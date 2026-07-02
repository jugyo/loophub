import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-settings-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");

beforeAll(async () => {
  svc = await import("./service.ts");
});

afterEach(() => {
  delete process.env.LOOPHUB_TERMINAL_LAUNCH_BACKEND;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("settings.get defaults to builtin (#474)", () => {
  expect(svc.settings.get()).toEqual({ terminalLaunchBackend: "builtin" });
});

test("settings.update persists to config.json and is reflected by settings.get (#474)", () => {
  const result = svc.settings.update({ terminalLaunchBackend: "herdr" });
  expect(result).toEqual({ terminalLaunchBackend: "herdr" });
  expect(svc.settings.get()).toEqual({ terminalLaunchBackend: "herdr" });

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.terminalLaunchBackend).toBe("herdr");
});

test("settings.update rejects an unknown backend (#474)", () => {
  expect(() =>
    svc.settings.update({ terminalLaunchBackend: "nope" as any }),
  ).toThrow(/terminalLaunchBackend must be/);
});

test("settings.update omitting terminalLaunchBackend preserves the persisted value (#474)", () => {
  svc.settings.update({ terminalLaunchBackend: "herdr" });
  // Mirrors the RPC handler forwarding a schema-valid request that omits the optional field.
  svc.settings.update({});
  expect(svc.settings.get()).toEqual({ terminalLaunchBackend: "herdr" });
});

test("LOOPHUB_TERMINAL_LAUNCH_BACKEND env var still overrides the persisted setting (#474)", () => {
  svc.settings.update({ terminalLaunchBackend: "herdr" });
  process.env.LOOPHUB_TERMINAL_LAUNCH_BACKEND = "builtin";
  expect(svc.settings.get()).toEqual({ terminalLaunchBackend: "builtin" });
});
