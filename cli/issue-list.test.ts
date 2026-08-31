import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

const CLI = join(import.meta.dirname, "index.ts");
const home = mkdtempSync(join(tmpdir(), "lh-issue-list-cli-"));
const env = {
  ...process.env,
  LOOPHUB_HOME: home,
  LOOPHUB_DB: join(home, "loophub.db"),
};

function node(args: string[]) {
  return spawnSync(process.execPath, [...args], { encoding: "utf8", env });
}

function lh(args: string[]) {
  const result = node([CLI, ...args, "--repo", "me/list-cli"]);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

beforeAll(() => {
  // 40 pulls created first, then 35 issues: with a pull-inclusive page the first page would be
  // mostly pulls and the visible issue count would collapse (#2524).
  const setup = node([
    "--eval",
    `
      const S = await import("./core/store.ts");
      const repo = S.createRepo("me/list-cli", "/tmp/list-cli");
      for (let i = 0; i < 40; i++) {
        const pull = S.createIssue(repo.id, "pull", "Pull " + i, "", "me");
        S.createPull(pull.id, "feature-" + i, "main", null);
      }
      for (let i = 0; i < 35; i++) S.createIssue(repo.id, "issue", "Issue " + i, "", "me");
    `,
  ]);
  expect(setup.status, setup.stderr).toBe(0);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("issue list fills its page with issues instead of letting pulls take the budget", () => {
  const result = lh(["issue", "list", "--json"]);

  expect(result.exitCode, result.stderr).toBe(0);
  const items = JSON.parse(result.stdout);
  expect(items).toHaveLength(30);
  expect(items.every((i: any) => !i.pull_request)).toBe(true);
});

test("issue list reports truncation on stderr so a --json caller sees the total", () => {
  const result = lh(["issue", "list", "--json"]);

  expect(result.stderr).toContain("showing 30 of 35");
});

test("issue list pages through the remaining issues with --page/--limit", () => {
  const first = lh(["issue", "list", "--limit", "20", "--json"]);
  const second = lh([
    "issue",
    "list",
    "--limit",
    "20",
    "--page",
    "2",
    "--json",
  ]);

  expect(first.exitCode, first.stderr).toBe(0);
  expect(second.exitCode, second.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toHaveLength(20);
  expect(JSON.parse(second.stdout)).toHaveLength(15);
  expect(second.stderr).toContain("showing 15 of 35");
});

test("issue list stays quiet when a single page holds every issue", () => {
  const result = lh(["issue", "list", "--limit", "50", "--json"]);

  expect(JSON.parse(result.stdout)).toHaveLength(35);
  expect(result.stderr).not.toContain("showing");
});

test("issue list rejects an out-of-range --limit", () => {
  const result = lh(["issue", "list", "--limit", "500"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--limit must be between 1 and 100");
});
