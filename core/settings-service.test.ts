import { spawnSync } from "node:child_process";
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

// settings.get() reports the resolved model/effort next to the raw config.json override (#362).
// `override` names the fields this test has already written; anything omitted has no override, so
// the resolved value comes from the runtime registry default.
function agentWire(
  model: string,
  effort: string,
  override: { model?: string; effort?: string } = {},
) {
  return {
    model,
    effort,
    modelOverride: override.model ?? "",
    effortOverride: override.effort ?? "",
  };
}

test("settings.get defaults to the model/effort for every agent and claude-code", () => {
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": agentWire("opus", "medium"),
      codex: agentWire("gpt-5.6-sol", "medium"),
      opencode: agentWire("opencode/big-pickle", ""),
      grok: agentWire("grok-code-fast-1", "medium"),
    },
    codingAgent: "claude-code",
    devCostLimitUsd: 10,
    notificationSound: true,
    theme: null,
    workflowContractLanguage: "en",
    publicOrigin: null,
  });
});

test("settings.update persists workflowContractLanguage in the database", () => {
  expect(
    svc.settings.update({ workflowContractLanguage: "ja" })
      .workflowContractLanguage,
  ).toBe("ja");
  expect(svc.settings.get().workflowContractLanguage).toBe("ja");
  const restarted = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const { settings } = await import("./core/service.ts"); process.stdout.write(settings.get().workflowContractLanguage);',
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  expect(restarted.status, restarted.stderr).toBe(0);
  expect(restarted.stdout).toBe("ja");
  expect(() =>
    svc.settings.update({ workflowContractLanguage: "fr" as "en" }),
  ).toThrow(/workflowContractLanguage must be one of: en, ja/);
  svc.settings.update({ workflowContractLanguage: "en" });
});

test("settings.update persists and validates the exact public origin", () => {
  expect(
    svc.settings.update({ publicOrigin: "https://loop.example.com" })
      .publicOrigin,
  ).toBe("https://loop.example.com");
  expect(svc.settings.get().publicOrigin).toBe("https://loop.example.com");
  expect(() => svc.settings.update({ publicOrigin: "*" })).toThrow(
    /valid HTTPS origin/,
  );
  expect(() =>
    svc.settings.update({ publicOrigin: "https://example.com/path" }),
  ).toThrow(/valid HTTPS origin/);
  expect(svc.settings.update({ publicOrigin: null }).publicOrigin).toBeNull();
});

test("settings.update persists a per-agent model and is reflected by settings.get (#594)", () => {
  const result = svc.settings.update({
    agent: "claude-code",
    model: "claude-opus-4-8",
  });
  expect(result).toEqual({
    agents: {
      "claude-code": agentWire("claude-opus-4-8", "medium", {
        model: "claude-opus-4-8",
      }),
      codex: agentWire("gpt-5.6-sol", "medium"),
      opencode: agentWire("opencode/big-pickle", ""),
      grok: agentWire("grok-code-fast-1", "medium"),
    },
    codingAgent: "claude-code",
    devCostLimitUsd: 10,
    notificationSound: true,
    theme: null,
    workflowContractLanguage: "en",
    publicOrigin: null,
  });
  expect(svc.settings.get()).toEqual(result);

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.agents["claude-code"]).toEqual({
    defaultModel: "claude-opus-4-8",
  });

  svc.settings.update({ agent: "claude-code", model: "opus" });
});

test("settings.update sets one agent's model without disturbing another's (#594)", () => {
  svc.settings.update({ agent: "claude-code", model: "sonnet" });
  svc.settings.update({ agent: "codex", model: "gpt-5.5-codex" });
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": agentWire("sonnet", "medium", { model: "sonnet" }),
      codex: agentWire("gpt-5.5-codex", "medium", { model: "gpt-5.5-codex" }),
      opencode: agentWire("opencode/big-pickle", ""),
      grok: agentWire("grok-code-fast-1", "medium"),
    },
    codingAgent: "claude-code",
    devCostLimitUsd: 10,
    notificationSound: true,
    theme: null,
    workflowContractLanguage: "en",
    publicOrigin: null,
  });

  svc.settings.update({ agent: "claude-code", model: "opus" });
  svc.settings.update({ agent: "codex", model: "gpt-5.6-sol" });
});

// An empty model is no longer rejected: it is the Settings screen's Default choice, which removes
// the override (#362, covered by core/service/settings.test.ts).
test("settings.update rejects a non-string model (#594)", () => {
  expect(() =>
    svc.settings.update({ agent: "claude-code", model: 123 as any }),
  ).toThrow(/model must be a string/);
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
      "claude-code": agentWire("sonnet", "medium", { model: "sonnet" }),
      codex: agentWire("gpt-5.6-sol", "medium", { model: "gpt-5.6-sol" }),
      opencode: agentWire("opencode/big-pickle", ""),
      grok: agentWire("grok-code-fast-1", "medium"),
    },
    codingAgent: "claude-code",
    devCostLimitUsd: 10,
    notificationSound: true,
    theme: null,
    workflowContractLanguage: "en",
    publicOrigin: null,
  });

  svc.settings.update({ agent: "claude-code", model: "opus" });
});

test("settings.update persists a per-agent effort and is reflected by settings.get (#682)", () => {
  const result = svc.settings.update({
    agent: "claude-code",
    effort: "high",
  });
  expect(result).toEqual({
    agents: {
      "claude-code": agentWire("opus", "high", {
        model: "opus",
        effort: "high",
      }),
      codex: agentWire("gpt-5.6-sol", "medium", { model: "gpt-5.6-sol" }),
      opencode: agentWire("opencode/big-pickle", ""),
      grok: agentWire("grok-code-fast-1", "medium"),
    },
    codingAgent: "claude-code",
    devCostLimitUsd: 10,
    notificationSound: true,
    theme: null,
    workflowContractLanguage: "en",
    publicOrigin: null,
  });
  expect(svc.settings.get()).toEqual(result);

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.agents["claude-code"]).toEqual({
    defaultModel: "opus",
    defaultEffort: "high",
  });

  svc.settings.update({ agent: "claude-code", effort: "medium" });
});

test("settings.update sets one agent's effort without disturbing another's (#682)", () => {
  svc.settings.update({ agent: "claude-code", effort: "xhigh" });
  svc.settings.update({ agent: "codex", effort: "low" });
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": agentWire("opus", "xhigh", {
        model: "opus",
        effort: "xhigh",
      }),
      codex: agentWire("gpt-5.6-sol", "low", {
        model: "gpt-5.6-sol",
        effort: "low",
      }),
      opencode: agentWire("opencode/big-pickle", ""),
      grok: agentWire("grok-code-fast-1", "medium"),
    },
    codingAgent: "claude-code",
    devCostLimitUsd: 10,
    notificationSound: true,
    theme: null,
    workflowContractLanguage: "en",
    publicOrigin: null,
  });

  svc.settings.update({ agent: "claude-code", effort: "medium" });
  svc.settings.update({ agent: "codex", effort: "medium" });
});

// As with the model, an empty effort removes the override rather than failing (#362).
test("settings.update rejects a non-string effort (#682)", () => {
  expect(() =>
    svc.settings.update({ agent: "claude-code", effort: 123 as any }),
  ).toThrow(/effort must be a string/);
});

test("settings.update rejects effort without a valid agent (#682)", () => {
  expect(() => svc.settings.update({ effort: "high" } as any)).toThrow(
    /agent must be one of/,
  );
  expect(() =>
    svc.settings.update({ agent: "bogus" as any, effort: "high" }),
  ).toThrow(/agent must be one of/);
});

test("settings.update omitting effort preserves the persisted value (#682)", () => {
  svc.settings.update({ agent: "claude-code", effort: "xhigh" });
  svc.settings.update({});
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": agentWire("opus", "xhigh", {
        model: "opus",
        effort: "xhigh",
      }),
      codex: agentWire("gpt-5.6-sol", "medium", {
        model: "gpt-5.6-sol",
        effort: "medium",
      }),
      opencode: agentWire("opencode/big-pickle", ""),
      grok: agentWire("grok-code-fast-1", "medium"),
    },
    codingAgent: "claude-code",
    devCostLimitUsd: 10,
    notificationSound: true,
    theme: null,
    workflowContractLanguage: "en",
    publicOrigin: null,
  });

  svc.settings.update({ agent: "claude-code", effort: "medium" });
});

test("settings.update persists codingAgent and is reflected by settings.get (#516)", () => {
  const result = svc.settings.update({ codingAgent: "codex" });
  expect(result).toEqual({
    agents: {
      "claude-code": agentWire("opus", "medium", {
        model: "opus",
        effort: "medium",
      }),
      codex: agentWire("gpt-5.6-sol", "medium", {
        model: "gpt-5.6-sol",
        effort: "medium",
      }),
      opencode: agentWire("opencode/big-pickle", ""),
      grok: agentWire("grok-code-fast-1", "medium"),
    },
    codingAgent: "codex",
    devCostLimitUsd: 10,
    notificationSound: true,
    theme: null,
    workflowContractLanguage: "en",
    publicOrigin: null,
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

test("settings.update accepts grok as an agent-scoped and default coding agent", () => {
  svc.settings.update({ agent: "grok", model: "grok-4", effort: "high" });
  svc.settings.update({ codingAgent: "grok" });
  const got = svc.settings.get();
  expect(got.codingAgent).toBe("grok");
  expect(got.agents.grok).toEqual(
    agentWire("grok-4", "high", { model: "grok-4", effort: "high" }),
  );

  // Restore defaults so later tests see the untouched baseline.
  svc.settings.update({ agent: "grok", model: "grok-code-fast-1" });
  svc.settings.update({ agent: "grok", effort: "medium" });
  svc.settings.update({ codingAgent: "claude-code" });
});

test("settings.update accepts OpenCode as an agent-scoped and default coding agent", () => {
  svc.settings.update({
    agent: "opencode",
    model: "openai/gpt-5.6",
    // OpenCode has no effort ladder (TUI has no --variant).
    effort: "",
  });
  svc.settings.update({ codingAgent: "opencode" });
  const got = svc.settings.get();
  expect(got.codingAgent).toBe("opencode");
  expect(got.agents.opencode).toEqual(
    agentWire("openai/gpt-5.6", "", { model: "openai/gpt-5.6" }),
  );

  // Restore defaults so later tests see the untouched baseline.
  svc.settings.update({
    agent: "opencode",
    model: "opencode/big-pickle",
    effort: "",
  });
  svc.settings.update({ codingAgent: "claude-code" });
});

test("settings.update omitting codingAgent preserves the persisted value (#516)", () => {
  svc.settings.update({ codingAgent: "codex" });
  svc.settings.update({});
  expect(svc.settings.get()).toEqual({
    agents: {
      "claude-code": agentWire("opus", "medium", {
        model: "opus",
        effort: "medium",
      }),
      codex: agentWire("gpt-5.6-sol", "medium", {
        model: "gpt-5.6-sol",
        effort: "medium",
      }),
      opencode: agentWire("opencode/big-pickle", "", {
        model: "opencode/big-pickle",
      }),
      grok: agentWire("grok-code-fast-1", "medium", {
        model: "grok-code-fast-1",
        effort: "medium",
      }),
    },
    codingAgent: "codex",
    devCostLimitUsd: 10,
    notificationSound: true,
    theme: null,
    workflowContractLanguage: "en",
    publicOrigin: null,
  });

  svc.settings.update({ codingAgent: "claude-code" });
});

test("settings.update persists devCostLimitUsd and is reflected by settings.get (#1027)", () => {
  const result = svc.settings.update({ devCostLimitUsd: 7.25 });
  expect(result.devCostLimitUsd).toBe(7.25);
  expect(svc.settings.get().devCostLimitUsd).toBe(7.25);

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.devCostLimitUsd).toBe(7.25);

  svc.settings.update({ devCostLimitUsd: 10 });
});

test("settings.update persists theme in the database", () => {
  expect(svc.settings.update({ theme: "midnight" }).theme).toBe("midnight");
  expect(svc.settings.get().theme).toBe("midnight");

  const restarted = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const { settings } = await import("./core/service.ts"); process.stdout.write(settings.get().theme ?? "null");',
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  expect(restarted.status, restarted.stderr).toBe(0);
  expect(restarted.stdout).toBe("midnight");
  expect(() => svc.settings.update({ theme: "neon" as any })).toThrow(
    /theme must be a supported theme/,
  );
});

test("settings.update accepts valid cent amounts despite floating-point representation (#1027)", () => {
  svc.settings.update({ devCostLimitUsd: 2.55 });
  expect(svc.settings.get().devCostLimitUsd).toBe(2.55);

  svc.settings.update({ devCostLimitUsd: 0.29 });
  expect(svc.settings.get().devCostLimitUsd).toBe(0.29);

  svc.settings.update({ devCostLimitUsd: 10 });
});

test("settings.update rejects unnatural devCostLimitUsd values (#1027)", () => {
  for (const bad of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.001,
    1001,
  ]) {
    expect(() =>
      svc.settings.update({ devCostLimitUsd: bad as number }),
    ).toThrow(/devCostLimitUsd/);
  }
});

test("settings.update validates every field before writing config (#1027)", () => {
  expect(svc.settings.get().codingAgent).toBe("claude-code");

  expect(() =>
    svc.settings.update({ codingAgent: "codex", devCostLimitUsd: 0 }),
  ).toThrow(/devCostLimitUsd/);

  expect(svc.settings.get().codingAgent).toBe("claude-code");
});

test("settings.update omitting devCostLimitUsd preserves the persisted value (#1027)", () => {
  svc.settings.update({ devCostLimitUsd: 3.5 });
  svc.settings.update({});
  expect(svc.settings.get().devCostLimitUsd).toBe(3.5);

  svc.settings.update({ devCostLimitUsd: 10 });
});

test("settings.update persists notificationSound and is reflected by settings.get (#2508)", () => {
  expect(svc.settings.get().notificationSound).toBe(true);

  expect(
    svc.settings.update({ notificationSound: false }).notificationSound,
  ).toBe(false);
  expect(svc.settings.get().notificationSound).toBe(false);

  const raw = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  expect(raw.notificationSound).toBe(false);

  svc.settings.update({});
  expect(svc.settings.get().notificationSound).toBe(false);

  svc.settings.update({ notificationSound: true });
  expect(svc.settings.get().notificationSound).toBe(true);
});

test("settings.update rejects a non-boolean notificationSound (#2508)", () => {
  expect(() =>
    svc.settings.update({ notificationSound: "off" as unknown as boolean }),
  ).toThrow(/notificationSound/);
  expect(svc.settings.get().notificationSound).toBe(true);
});
