import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lh-config-"));
  process.env.LOOPHUB_HOME = dir;
  delete process.env.LOOPHUB_TERMINAL_LAUNCH_BACKEND;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LOOPHUB_HOME;
  delete process.env.LOOPHUB_TERMINAL_LAUNCH_BACKEND;
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

  updateConfig({ terminalLaunchBackend: "herdr" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    url: "http://example.test",
    terminalLaunchBackend: "herdr",
  });
});

test("updateConfig ignores undefined-valued keys instead of erasing the existing field (#474)", async () => {
  const { updateConfig } = await import("./config.ts");
  const path = join(dir, "config.json");

  updateConfig({ terminalLaunchBackend: "herdr" });
  // A caller (e.g. an RPC handler forwarding an omitted optional param) passing an explicit
  // `undefined` must not wipe the field that was already persisted.
  updateConfig({ terminalLaunchBackend: undefined });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    terminalLaunchBackend: "herdr",
  });
});

test("terminalLaunchBackend reflects updateConfig, with env var still taking priority", async () => {
  const { terminalLaunchBackend, updateConfig } = await import("./config.ts");
  expect(terminalLaunchBackend()).toBe("builtin"); // default

  updateConfig({ terminalLaunchBackend: "herdr" });
  expect(terminalLaunchBackend()).toBe("herdr");

  process.env.LOOPHUB_TERMINAL_LAUNCH_BACKEND = "builtin";
  expect(terminalLaunchBackend()).toBe("builtin"); // env overrides config.json
});

test("autoModeOnBuild defaults to false and reflects updateConfig (#499)", async () => {
  const { autoModeOnBuild, updateConfig } = await import("./config.ts");
  expect(autoModeOnBuild()).toBe(false); // default

  updateConfig({ autoModeOnBuild: true });
  expect(autoModeOnBuild()).toBe(true);

  updateConfig({ autoModeOnBuild: false });
  expect(autoModeOnBuild()).toBe(false);
});
