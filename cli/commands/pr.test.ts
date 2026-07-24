import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "..", "index.ts");
const home = mkdtempSync(join(tmpdir(), "lh-pr-cli-home-"));
const repoPath = mkdtempSync(join(tmpdir(), "lh-pr-cli-repo-"));

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

function lh(args: string[]) {
  const result = spawnSync(
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
      },
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

function createPull(branch: string): number {
  git(["checkout", "-q", "-b", branch, "main"]);
  writeFileSync(join(repoPath, `${branch}.txt`), "change\n");
  git(["add", "-A"]);
  git(["commit", "-qm", `work on ${branch}`]);
  git(["checkout", "-q", "main"]);
  const created = lh([
    "pr",
    "create",
    "--repo",
    "me/proj",
    "--title",
    `PR for ${branch}`,
    "--head",
    branch,
    "--json",
  ]);
  expect(created.exitCode, created.stderr).toBe(0);
  return JSON.parse(created.stdout).number;
}

beforeAll(() => {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "initial\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);

  const registered = lh(["repo", "add", repoPath, "--name", "me/proj"]);
  expect(registered.exitCode, registered.stderr).toBe(0);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("lh pr create and comment return the created resource", () => {
  const number = createPull("feature-comment");
  expect(number).toBeGreaterThan(0);

  const plain = lh([
    "pr",
    "comment",
    String(number),
    "--repo",
    "me/proj",
    "--body",
    "hello",
  ]);
  expect(plain.exitCode, plain.stderr).toBe(0);
  expect(plain.stdout).toContain(`commented on PR #${number} (comment `);

  const json = lh([
    "pr",
    "comment",
    String(number),
    "--repo",
    "me/proj",
    "--body",
    "second",
    "--json",
  ]);
  expect(json.exitCode, json.stderr).toBe(0);
  const comment = JSON.parse(json.stdout);
  expect(comment).toMatchObject({ body: "second" });
  expect(comment.id).toBeGreaterThan(0);
});

test("lh pr close / reopen report the transition and the no-op", () => {
  const number = createPull("feature-state");

  const closed = lh(["pr", "close", String(number), "--repo", "me/proj"]);
  expect(closed.exitCode, closed.stderr).toBe(0);
  expect(closed.stdout).toContain(`closed PR #${number} (open -> closed)`);

  const again = lh(["pr", "close", String(number), "--repo", "me/proj"]);
  expect(again.exitCode, again.stderr).toBe(0);
  expect(again.stdout).toContain(
    `PR #${number} was already closed (no change)`,
  );

  const reopened = lh([
    "pr",
    "reopen",
    String(number),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(reopened.exitCode, reopened.stderr).toBe(0);
  expect(JSON.parse(reopened.stdout)).toMatchObject({ number, state: "open" });
});
