import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");

let home: string;

// Run the CLI against an isolated HOME; `lh info` is DB-free so no repo/server setup is needed.
function lh(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPHUB_HOME: home,
        LOOPHUB_DB: join(home, "loophub.db"),
        // Drop any inherited overrides so the test controls resolution.
        LOOPHUB_URL: undefined as unknown as string,
        LOOPHUB_PORT: undefined as unknown as string,
        ...extraEnv,
      },
    },
  );
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "lh-info-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("--json reports baseUrl, home, dbPath; defaults to localhost:8730", () => {
  const { stdout, exitCode } = lh(["info", "--json"]);
  expect(exitCode).toBe(0);
  const info = JSON.parse(stdout);
  expect(info.baseUrl).toBe("http://localhost:8730");
  expect(info.home).toBe(home);
  expect(info.dbPath).toBe(join(home, "loophub.db"));
});

test("LOOPHUB_PORT changes the default baseUrl port", () => {
  const info = JSON.parse(
    lh(["info", "--json"], { LOOPHUB_PORT: "8731" }).stdout,
  );
  expect(info.baseUrl).toBe("http://localhost:8731");
});

test("LOOPHUB_URL overrides baseUrl", () => {
  const info = JSON.parse(
    lh(["info", "--json"], { LOOPHUB_URL: "https://hub.example" }).stdout,
  );
  expect(info.baseUrl).toBe("https://hub.example");
});

test("config.json url overrides the default", () => {
  const cfg = join(home, "config.json");
  writeFileSync(cfg, JSON.stringify({ url: "http://localhost:9000" }));
  try {
    const info = JSON.parse(lh(["info", "--json"]).stdout);
    expect(info.baseUrl).toBe("http://localhost:9000");
  } finally {
    // Don't leave the override in the shared HOME — keeps the suite order-independent.
    rmSync(cfg, { force: true });
  }
});

test("human output lists baseUrl/home/dbPath", () => {
  const { stdout } = lh(["info"]);
  expect(stdout).toContain("baseUrl\t");
  expect(stdout).toContain("home\t");
  expect(stdout).toContain("dbPath\t");
});
