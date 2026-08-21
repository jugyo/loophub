import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-events-"));
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "loophub.db");

function runEvents(args: string[]) {
  return spawnSync(process.execPath, ["cli/index.ts", "events", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
}

beforeAll(async () => {
  const S = await import("../core/store.ts");
  const repo = S.createRepo("me/events", process.cwd());
  S.emitEvent(repo.id, "example.first", "test", { sequence: 1 });
  S.emitEvent(repo.id, "example.second", "test", { sequence: 2 });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("lh events removed follow flags", () => {
  for (const flag of ["--follow", "-f"] as const) {
    it(`rejects ${flag} instead of silently running a snapshot`, () => {
      const result = runEvents([flag]);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} was removed`);
      expect(result.stderr).toContain("lh events --since <id> --order asc");
    });
  }
});

test("lh events applies --limit after descending ordering", () => {
  const result = runEvents([
    "--repo",
    "me/events",
    "--order",
    "desc",
    "--limit",
    "1",
    "--json",
  ]);

  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject([
    {
      type: "example.second",
      payload: { sequence: 2 },
    },
  ]);
});
