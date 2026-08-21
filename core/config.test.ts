import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lh-config-"));
  process.env.LOOPHUB_HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LOOPHUB_HOME;
});

test("updateConfig writes config.json atomically and preserves other fields", async () => {
  const { updateConfig } = await import("./config.ts");
  const path = join(dir, "config.json");
  expect(existsSync(path)).toBe(false);

  updateConfig({ url: "http://example.test" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    url: "http://example.test",
  });
  expect(existsSync(`${path}.tmp`)).toBe(false); // temp renamed away

  updateConfig({ codingAgent: "codex" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    url: "http://example.test",
    codingAgent: "codex",
  });
});

test("updateConfig ignores undefined-valued keys instead of erasing the existing field (#474)", async () => {
  const { updateConfig } = await import("./config.ts");
  const path = join(dir, "config.json");

  updateConfig({ codingAgent: "codex" });
  // A caller (e.g. an RPC handler forwarding an omitted optional param) passing an explicit
  // `undefined` must not wipe the field that was already persisted.
  updateConfig({ codingAgent: undefined });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    codingAgent: "codex",
  });
});

// A stale `terminalLaunchBackend` field left over from before the builtin/herdr switch was
// removed (#562) must round-trip through updateConfig untouched and never break reads of the
// other typed fields, since updateConfig merges into the raw parsed object rather than this
// module's typed GlobalConfig shape.
test("a stale terminalLaunchBackend field in config.json is preserved and ignored", async () => {
  const { codingAgent, updateAgentDefaultModel, updateConfig } = await import(
    "./config.ts"
  );
  const path = join(dir, "config.json");

  updateConfig({ terminalLaunchBackend: "builtin" } as never);
  updateAgentDefaultModel("claude-code", "opus");
  updateConfig({ codingAgent: "codex" });

  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    terminalLaunchBackend: "builtin",
    agents: { "claude-code": { defaultModel: "opus" } },
    codingAgent: "codex",
  });
  expect(codingAgent()).toBe("codex");
});

test("legacy auto mode settings are preserved and ignored", async () => {
  const { agentModel, updateAgentDefaultModel } = await import("./config.ts");
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      agents: {
        "claude-code": {
          autoModeOnLaunch: false,
          autoModeOnBuild: true,
        },
      },
    }),
  );
  updateAgentDefaultModel("claude-code", "sonnet");
  expect(agentModel("claude-code")).toBe("sonnet");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    agents: {
      "claude-code": {
        autoModeOnLaunch: false,
        autoModeOnBuild: true,
        defaultModel: "sonnet",
      },
    },
  });
});

test("agentModel defaults to DEFAULT_AGENT_MODEL per agent and reflects updateAgentDefaultModel (#594)", async () => {
  const { agentModel, DEFAULT_AGENT_MODEL, updateAgentDefaultModel } =
    await import("./config.ts");
  expect(agentModel("claude-code")).toBe(DEFAULT_AGENT_MODEL["claude-code"]);
  expect(agentModel("codex")).toBe(DEFAULT_AGENT_MODEL.codex);

  updateAgentDefaultModel("claude-code", "claude-opus-4-8");
  expect(agentModel("claude-code")).toBe("claude-opus-4-8");
  expect(agentModel("codex")).toBe(DEFAULT_AGENT_MODEL.codex); // unaffected
});

test("updateAgentDefaultModel sets one agent without disturbing another's setting (#594)", async () => {
  const { agentModel, updateAgentDefaultModel } = await import("./config.ts");

  updateAgentDefaultModel("claude-code", "claude-opus-4-8");
  updateAgentDefaultModel("codex", "gpt-5.5-codex");
  expect(agentModel("claude-code")).toBe("claude-opus-4-8");
  expect(agentModel("codex")).toBe("gpt-5.5-codex");

  updateAgentDefaultModel("claude-code", "sonnet");
  expect(agentModel("claude-code")).toBe("sonnet");
  expect(agentModel("codex")).toBe("gpt-5.5-codex"); // untouched
});

test("agentEffort defaults to DEFAULT_AGENT_EFFORT per agent and reflects updateAgentDefaultEffort (#682)", async () => {
  const { agentEffort, DEFAULT_AGENT_EFFORT, updateAgentDefaultEffort } =
    await import("./config.ts");
  expect(agentEffort("claude-code")).toBe(DEFAULT_AGENT_EFFORT["claude-code"]);
  expect(agentEffort("codex")).toBe(DEFAULT_AGENT_EFFORT.codex);

  updateAgentDefaultEffort("claude-code", "high");
  expect(agentEffort("claude-code")).toBe("high");
  expect(agentEffort("codex")).toBe(DEFAULT_AGENT_EFFORT.codex); // unaffected
});

test("devCostLimitUsd defaults to $10 and reflects updateDevCostLimitUsd (#1027)", async () => {
  const { DEFAULT_DEV_COST_LIMIT_USD, devCostLimitUsd, updateDevCostLimitUsd } =
    await import("./config.ts");
  expect(devCostLimitUsd()).toBe(DEFAULT_DEV_COST_LIMIT_USD);
  expect(DEFAULT_DEV_COST_LIMIT_USD).toBe(10);

  updateDevCostLimitUsd(2.5);
  expect(devCostLimitUsd()).toBe(2.5);
});

test("devCostLimitUsd ignores malformed persisted values (#1027)", async () => {
  const { DEFAULT_DEV_COST_LIMIT_USD, devCostLimitUsd, updateConfig } =
    await import("./config.ts");

  for (const bad of ["abc", 0, -5, Number.NaN]) {
    updateConfig({ devCostLimitUsd: bad as number });
    expect(devCostLimitUsd()).toBe(DEFAULT_DEV_COST_LIMIT_USD);
  }
});

test("updateAgentDefaultEffort sets one agent without disturbing another's setting (#682)", async () => {
  const { agentEffort, updateAgentDefaultEffort } = await import("./config.ts");

  updateAgentDefaultEffort("claude-code", "high");
  updateAgentDefaultEffort("codex", "low");
  expect(agentEffort("claude-code")).toBe("high");
  expect(agentEffort("codex")).toBe("low");

  updateAgentDefaultEffort("claude-code", "xhigh");
  expect(agentEffort("claude-code")).toBe("xhigh");
  expect(agentEffort("codex")).toBe("low"); // untouched
});

test("codingAgent defaults to claude-code and reflects updateConfig (#516)", async () => {
  const { codingAgent, updateConfig } = await import("./config.ts");
  expect(codingAgent()).toBe("claude-code"); // default

  updateConfig({ codingAgent: "codex" });
  expect(codingAgent()).toBe("codex");

  updateConfig({ codingAgent: "claude-code" });
  expect(codingAgent()).toBe("claude-code");
});

test("normalizeCodingAgent falls back to claude-code for an unknown value (#516)", async () => {
  const { normalizeCodingAgent } = await import("./config.ts");
  expect(normalizeCodingAgent("codex")).toBe("codex");
  expect(normalizeCodingAgent("grok")).toBe("grok");
  expect(normalizeCodingAgent("bogus")).toBe("claude-code");
  expect(normalizeCodingAgent(undefined)).toBe("claude-code");
});

test("grok is a coding agent with its own default model/effort", async () => {
  const {
    CODING_AGENTS,
    DEFAULT_AGENT_MODEL,
    DEFAULT_AGENT_EFFORT,
    agentModel,
    agentEffort,
    codingAgent,
    updateConfig,
    updateAgentDefaultModel,
  } = await import("./config.ts");

  expect(CODING_AGENTS).toContain("grok");
  expect(agentModel("grok")).toBe(DEFAULT_AGENT_MODEL.grok);
  expect(agentEffort("grok")).toBe(DEFAULT_AGENT_EFFORT.grok);

  updateConfig({ codingAgent: "grok" });
  expect(codingAgent()).toBe("grok");

  // A per-agent override for grok is honored and doesn't disturb the default fallback for others.
  updateAgentDefaultModel("grok", "grok-4");
  expect(agentModel("grok")).toBe("grok-4");
  expect(agentModel("codex")).toBe(DEFAULT_AGENT_MODEL.codex);

  updateConfig({ codingAgent: "claude-code" });
});

test("notificationSound defaults to on and reflects updateNotificationSound (#2508)", async () => {
  const {
    DEFAULT_NOTIFICATION_SOUND,
    notificationSound,
    updateConfig,
    updateNotificationSound,
  } = await import("./config.ts");
  expect(notificationSound()).toBe(DEFAULT_NOTIFICATION_SOUND);
  expect(DEFAULT_NOTIFICATION_SOUND).toBe(true);

  updateNotificationSound(false);
  expect(notificationSound()).toBe(false);

  // A malformed persisted value falls back to the default rather than silencing the bell.
  updateConfig({ notificationSound: "no" as unknown as boolean });
  expect(notificationSound()).toBe(DEFAULT_NOTIFICATION_SOUND);

  updateNotificationSound(true);
});
