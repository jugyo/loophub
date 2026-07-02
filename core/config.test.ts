import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  updateConfig({ autoModeOnBuild: true });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    url: "http://example.test",
    autoModeOnBuild: true,
  });
});

test("updateConfig ignores undefined-valued keys instead of erasing the existing field (#474)", async () => {
  const { updateConfig } = await import("./config.ts");
  const path = join(dir, "config.json");

  updateConfig({ autoModeOnBuild: true });
  // A caller (e.g. an RPC handler forwarding an omitted optional param) passing an explicit
  // `undefined` must not wipe the field that was already persisted.
  updateConfig({ autoModeOnBuild: undefined });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    autoModeOnBuild: true,
  });
});

// A stale `terminalLaunchBackend` field left over from before the builtin/herdr switch was
// removed (#562) must round-trip through updateConfig untouched and never break reads of the
// other typed fields, since updateConfig merges into the raw parsed object rather than this
// module's typed GlobalConfig shape.
test("a stale terminalLaunchBackend field in config.json is preserved and ignored", async () => {
  const { autoModeOnBuild, codingAgent, updateConfig } = await import(
    "./config.ts"
  );
  const path = join(dir, "config.json");

  updateConfig({ terminalLaunchBackend: "builtin" } as never);
  updateConfig({ autoModeOnBuild: true, codingAgent: "codex" });

  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    terminalLaunchBackend: "builtin",
    autoModeOnBuild: true,
    codingAgent: "codex",
  });
  expect(autoModeOnBuild()).toBe(true);
  expect(codingAgent()).toBe("codex");
});

test("autoModeOnBuild defaults to false and reflects updateConfig (#499)", async () => {
  const { autoModeOnBuild, updateConfig } = await import("./config.ts");
  expect(autoModeOnBuild()).toBe(false); // default

  updateConfig({ autoModeOnBuild: true });
  expect(autoModeOnBuild()).toBe(true);

  updateConfig({ autoModeOnBuild: false });
  expect(autoModeOnBuild()).toBe(false);
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
  expect(normalizeCodingAgent("bogus")).toBe("claude-code");
  expect(normalizeCodingAgent(undefined)).toBe("claude-code");
});
