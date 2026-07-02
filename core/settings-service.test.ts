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

test("settings.get defaults to builtin / auto mode off / claude-code (#474, #499, #516)", () => {
  expect(svc.settings.get()).toEqual({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: false,
    codingAgent: "claude-code",
  });
});

test("settings.update persists to config.json and is reflected by settings.get (#474)", () => {
  const result = svc.settings.update({ terminalLaunchBackend: "herdr" });
  expect(result).toEqual({
    terminalLaunchBackend: "herdr",
    autoModeOnBuild: false,
    codingAgent: "claude-code",
  });
  expect(svc.settings.get()).toEqual({
    terminalLaunchBackend: "herdr",
    autoModeOnBuild: false,
    codingAgent: "claude-code",
  });

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
  expect(svc.settings.get()).toEqual({
    terminalLaunchBackend: "herdr",
    autoModeOnBuild: false,
    codingAgent: "claude-code",
  });
});

test("LOOPHUB_TERMINAL_LAUNCH_BACKEND env var still overrides the persisted setting (#474)", () => {
  svc.settings.update({ terminalLaunchBackend: "herdr" });
  process.env.LOOPHUB_TERMINAL_LAUNCH_BACKEND = "builtin";
  expect(svc.settings.get()).toEqual({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: false,
    codingAgent: "claude-code",
  });
});

test("settings.update persists autoModeOnBuild and is reflected by settings.get (#499)", () => {
  // Pin terminalLaunchBackend too: settings.update only patches fields it's given, and prior
  // tests in this file may have left it as "herdr" — pin it so this test's expectations don't
  // depend on run order.
  svc.settings.update({ terminalLaunchBackend: "builtin" });
  const result = svc.settings.update({ autoModeOnBuild: true });
  expect(result).toEqual({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: true,
    codingAgent: "claude-code",
  });
  expect(svc.settings.get()).toEqual({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: true,
    codingAgent: "claude-code",
  });

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.autoModeOnBuild).toBe(true);
});

test("settings.update rejects a non-boolean autoModeOnBuild (#499)", () => {
  expect(() => svc.settings.update({ autoModeOnBuild: "yes" as any })).toThrow(
    /autoModeOnBuild must be a boolean/,
  );
});

test("settings.update omitting autoModeOnBuild preserves the persisted value (#499)", () => {
  svc.settings.update({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: true,
  });
  svc.settings.update({});
  expect(svc.settings.get()).toEqual({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: true,
    codingAgent: "claude-code",
  });
});

test("settings.update persists codingAgent and is reflected by settings.get (#516)", () => {
  // Pin the other fields too, for the same run-order-independence reason as above.
  svc.settings.update({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: false,
  });
  const result = svc.settings.update({ codingAgent: "codex" });
  expect(result).toEqual({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: false,
    codingAgent: "codex",
  });
  expect(svc.settings.get()).toEqual({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: false,
    codingAgent: "codex",
  });

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.codingAgent).toBe("codex");
});

test("settings.update rejects an unknown codingAgent (#516)", () => {
  expect(() => svc.settings.update({ codingAgent: "nope" as any })).toThrow(
    /codingAgent must be one of/,
  );
});

test("settings.update omitting codingAgent preserves the persisted value (#516)", () => {
  svc.settings.update({ codingAgent: "codex" });
  svc.settings.update({});
  expect(svc.settings.get()).toEqual({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: false,
    codingAgent: "codex",
  });
});
