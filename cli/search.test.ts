import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const home = mkdtempSync(join(tmpdir(), "lh-search-cli-"));
const env = {
  ...process.env,
  LOOPHUB_HOME: home,
  LOOPHUB_DB: join(home, "loophub.db"),
};

function node(args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      ...args,
    ],
    { encoding: "utf8", env },
  );
}

function lh(args: string[]) {
  const result = node([CLI, ...args]);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

beforeAll(() => {
  const setup = node([
    "--eval",
    `
      const S = await import("./core/store.ts");
      const repo = S.createRepo("me/search-cli", "/tmp/search-cli");
      const other = S.createRepo("me/other-cli", "/tmp/other-cli");
      S.createIssue(repo.id, "issue", "Shared search issue", "", "me");
      const pull = S.createIssue(repo.id, "pull", "Shared search pull", "", "me");
      S.createPull(pull.id, "feature", "main", null);
      S.createIssue(other.id, "issue", "Shared search elsewhere", "", "me");
    `,
  ]);
  expect(setup.status, setup.stderr).toBe(0);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("issue search prints mixed issue and pull results for the selected repository", () => {
  const result = lh([
    "issue",
    "search",
    "shared search",
    "--repo",
    "me/search-cli",
  ]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("issue\t#1\topen\tShared search issue");
  expect(result.stdout).toContain("pull\t#2\topen\tShared search pull");
  expect(result.stdout).not.toContain("elsewhere");
});

test("issue search returns machine-readable JSON", () => {
  const result = lh([
    "issue",
    "search",
    "shared",
    "--repo",
    "me/search-cli",
    "--json",
  ]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    {
      kind: "pull",
      number: 2,
      title: "Shared search pull",
      state: "open",
    },
    {
      kind: "issue",
      number: 1,
      title: "Shared search issue",
      state: "open",
    },
  ]);
});

test("issue search reports an empty result and exits successfully", () => {
  const result = lh(["issue", "search", "missing", "--repo", "me/search-cli"]);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("No results.\n");
});

test("issue search propagates service errors through the standard CLI path", () => {
  const result = lh(["issue", "search", "shared", "--repo", "me/missing"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("error 404: Not Found\n");
});
