import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-settings-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");

beforeAll(async () => {
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("settings.get defaults to auto mode off / claude-code (#474, #499, #516)", () => {
  expect(svc.settings.get()).toEqual({
    autoModeOnBuild: false,
    codingAgent: "claude-code",
  });
});

test("settings.update persists autoModeOnBuild and is reflected by settings.get (#499)", () => {
  const result = svc.settings.update({ autoModeOnBuild: true });
  expect(result).toEqual({
    autoModeOnBuild: true,
    codingAgent: "claude-code",
  });
  expect(svc.settings.get()).toEqual({
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
  svc.settings.update({ autoModeOnBuild: true });
  svc.settings.update({});
  expect(svc.settings.get()).toEqual({
    autoModeOnBuild: true,
    codingAgent: "claude-code",
  });
});

test("settings.update persists codingAgent and is reflected by settings.get (#516)", () => {
  // Pin the other field too, for run-order-independence.
  svc.settings.update({ autoModeOnBuild: false });
  const result = svc.settings.update({ codingAgent: "codex" });
  expect(result).toEqual({
    autoModeOnBuild: false,
    codingAgent: "codex",
  });
  expect(svc.settings.get()).toEqual({
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
    autoModeOnBuild: false,
    codingAgent: "codex",
  });
});
