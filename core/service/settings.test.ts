import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { RUNTIMES } from "../runtimes.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-settings-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("../service.ts");

function config(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

beforeAll(async () => {
  svc = await import("../service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("reports the resolved value and the raw override per agent", () => {
  const before = svc.settings.get().agents["claude-code"];
  expect(before).toMatchObject({
    model: RUNTIMES["claude-code"].defaultModel,
    effort: RUNTIMES["claude-code"].defaultEffort,
    modelOverride: "",
    effortOverride: "",
  });

  const after = svc.settings.update({
    agent: "claude-code",
    model: "claude-opus-4-8",
    effort: "xhigh",
  }).agents["claude-code"];
  expect(after).toMatchObject({
    model: "claude-opus-4-8",
    effort: "xhigh",
    modelOverride: "claude-opus-4-8",
    effortOverride: "xhigh",
  });
});

// #362: the Settings screen's Default entry saves an empty model/effort. That is the explicit
// "no override" choice, not a malformed value, so it must clear the config.json entry rather
// than 422 — including for runtimes that offer effort levels.
test("clears the override when model or effort is empty", () => {
  svc.settings.update({ agent: "codex", model: "gpt-5.5", effort: "high" });
  expect(config().agents.codex).toEqual({
    defaultModel: "gpt-5.5",
    defaultEffort: "high",
  });

  const cleared = svc.settings.update({
    agent: "codex",
    model: "",
    effort: "",
  });
  expect(config().agents.codex).toEqual({});
  expect(cleared.agents.codex).toMatchObject({
    model: RUNTIMES.codex.defaultModel,
    effort: RUNTIMES.codex.defaultEffort,
    modelOverride: "",
    effortOverride: "",
  });
});

test("clearing one field leaves the other agent settings untouched", () => {
  svc.settings.update({ agent: "grok", model: "grok-4", effort: "high" });
  svc.settings.update({ agent: "grok", effort: "" });

  expect(config().agents.grok).toEqual({ defaultModel: "grok-4" });
  expect(svc.settings.get().agents.grok).toMatchObject({
    model: "grok-4",
    modelOverride: "grok-4",
    effort: RUNTIMES.grok.defaultEffort,
    effortOverride: "",
  });
});

test("still requires an agent for a model or effort change", () => {
  expect(() => svc.settings.update({ model: "" })).toThrow(/agent must be one/);
  expect(() => svc.settings.update({ effort: "" })).toThrow(
    /agent must be one/,
  );
});
