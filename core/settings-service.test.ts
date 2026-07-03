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

test("settings.get defaults to auto mode off and the default model for every agent / claude-code (#474, #499, #516, #593, #594)", () => {
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": { autoModeOnBuild: false, model: "opus" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5" },
    },
    codingAgent: "claude-code",
  });
});

test("settings.update persists a per-agent autoModeOnBuild and is reflected by settings.get (#499, #593)", () => {
  const result = svc.settings.update({
    agent: "claude-code",
    autoModeOnBuild: true,
  });
  expect(result).toEqual({
    agents: {
      "claude-code": { autoModeOnBuild: true, model: "opus" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5" },
    },
    codingAgent: "claude-code",
  });
  expect(svc.settings.get()).toEqual(result);

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.agents["claude-code"]).toEqual({ autoModeOnBuild: true });

  svc.settings.update({ agent: "claude-code", autoModeOnBuild: false });
});

test("settings.update sets one agent's autoModeOnBuild without disturbing another's (#593)", () => {
  svc.settings.update({ agent: "claude-code", autoModeOnBuild: true });
  svc.settings.update({ agent: "codex", autoModeOnBuild: true });
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": { autoModeOnBuild: true, model: "opus" },
      codex: { autoModeOnBuild: true, model: "gpt-5.5" },
    },
    codingAgent: "claude-code",
  });

  svc.settings.update({ agent: "claude-code", autoModeOnBuild: false });
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": { autoModeOnBuild: false, model: "opus" },
      codex: { autoModeOnBuild: true, model: "gpt-5.5" },
    },
    codingAgent: "claude-code",
  });

  svc.settings.update({ agent: "codex", autoModeOnBuild: false });
});

test("settings.update rejects a non-boolean autoModeOnBuild (#499)", () => {
  expect(() =>
    svc.settings.update({
      agent: "claude-code",
      autoModeOnBuild: "yes" as any,
    }),
  ).toThrow(/autoModeOnBuild must be a boolean/);
});

test("settings.update rejects autoModeOnBuild without a valid agent (#593)", () => {
  expect(() => svc.settings.update({ autoModeOnBuild: true } as any)).toThrow(
    /agent must be one of/,
  );
  expect(() =>
    svc.settings.update({ agent: "bogus" as any, autoModeOnBuild: true }),
  ).toThrow(/agent must be one of/);
});

test("settings.update omitting autoModeOnBuild preserves the persisted value (#499)", () => {
  svc.settings.update({ agent: "claude-code", autoModeOnBuild: true });
  svc.settings.update({});
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": { autoModeOnBuild: true, model: "opus" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5" },
    },
    codingAgent: "claude-code",
  });

  svc.settings.update({ agent: "claude-code", autoModeOnBuild: false });
});

test("settings.update persists a per-agent model and is reflected by settings.get (#594)", () => {
  const result = svc.settings.update({
    agent: "claude-code",
    model: "claude-opus-4-8",
  });
  expect(result).toEqual({
    agents: {
      "claude-code": { autoModeOnBuild: false, model: "claude-opus-4-8" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5" },
    },
    codingAgent: "claude-code",
  });
  expect(svc.settings.get()).toEqual(result);

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.agents["claude-code"]).toEqual({
    autoModeOnBuild: false,
    defaultModel: "claude-opus-4-8",
  });

  svc.settings.update({ agent: "claude-code", model: "opus" });
});

test("settings.update sets one agent's model without disturbing another's (#594)", () => {
  svc.settings.update({ agent: "claude-code", model: "sonnet" });
  svc.settings.update({ agent: "codex", model: "gpt-5.5-codex" });
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": { autoModeOnBuild: false, model: "sonnet" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5-codex" },
    },
    codingAgent: "claude-code",
  });

  svc.settings.update({ agent: "claude-code", model: "opus" });
  svc.settings.update({ agent: "codex", model: "gpt-5.5" });
});

test("settings.update rejects a non-string or empty model (#594)", () => {
  expect(() =>
    svc.settings.update({ agent: "claude-code", model: "" }),
  ).toThrow(/model must be a non-empty string/);
  expect(() =>
    svc.settings.update({ agent: "claude-code", model: 123 as any }),
  ).toThrow(/model must be a non-empty string/);
});

test("settings.update rejects model without a valid agent (#594)", () => {
  expect(() => svc.settings.update({ model: "opus" } as any)).toThrow(
    /agent must be one of/,
  );
  expect(() =>
    svc.settings.update({ agent: "bogus" as any, model: "opus" }),
  ).toThrow(/agent must be one of/);
});

test("settings.update omitting model preserves the persisted value (#594)", () => {
  svc.settings.update({ agent: "claude-code", model: "sonnet" });
  svc.settings.update({});
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": { autoModeOnBuild: false, model: "sonnet" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5" },
    },
    codingAgent: "claude-code",
  });

  svc.settings.update({ agent: "claude-code", model: "opus" });
});

test("settings.update persists codingAgent and is reflected by settings.get (#516)", () => {
  const result = svc.settings.update({ codingAgent: "codex" });
  expect(result).toEqual({
    agents: {
      "claude-code": { autoModeOnBuild: false, model: "opus" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5" },
    },
    codingAgent: "codex",
  });
  expect(svc.settings.get()).toEqual(result);

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.codingAgent).toBe("codex");

  svc.settings.update({ codingAgent: "claude-code" });
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
    agents: {
      "claude-code": { autoModeOnBuild: false, model: "opus" },
      codex: { autoModeOnBuild: false, model: "gpt-5.5" },
    },
    codingAgent: "codex",
  });

  svc.settings.update({ codingAgent: "claude-code" });
});
