import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "..", "index.ts");
const home = mkdtempSync(join(tmpdir(), "lh-issue-cli-home-"));
const repoPath = mkdtempSync(join(tmpdir(), "lh-issue-cli-repo-"));

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

function createIssue(title: string): number {
  const created = lh([
    "issue",
    "create",
    "--repo",
    "me/proj",
    "--title",
    title,
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

test("lh issue create returns the created issue with --json", () => {
  const number = createIssue("json create");
  expect(number).toBeGreaterThan(0);

  const plain = lh([
    "issue",
    "create",
    "--repo",
    "me/proj",
    "--title",
    "plain create",
  ]);
  expect(plain.exitCode, plain.stderr).toBe(0);
  expect(plain.stdout.trim()).toMatch(/^created #\d+$/);
});

test("lh issue comment returns the created comment", () => {
  const number = createIssue("comment target");

  const plain = lh([
    "issue",
    "comment",
    String(number),
    "--repo",
    "me/proj",
    "--body",
    "hello",
  ]);
  expect(plain.exitCode, plain.stderr).toBe(0);
  expect(plain.stdout).toContain(`commented on #${number} (comment `);

  const json = lh([
    "issue",
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

test("lh issue close reports the state transition and the already-closed no-op", () => {
  const number = createIssue("close target");

  const closed = lh(["issue", "close", String(number), "--repo", "me/proj"]);
  expect(closed.exitCode, closed.stderr).toBe(0);
  expect(closed.stdout).toContain(`closed #${number} (open -> closed)`);

  const again = lh(["issue", "close", String(number), "--repo", "me/proj"]);
  expect(again.exitCode, again.stderr).toBe(0);
  expect(again.stdout).toContain(`#${number} was already closed (no change)`);

  const json = lh([
    "issue",
    "close",
    String(number),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(json.exitCode, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({ number, state: "closed" });
});

test("lh issue label reports the resulting labels and the no-op add", () => {
  const number = createIssue("label target");

  const labeled = lh([
    "issue",
    "label",
    String(number),
    "--repo",
    "me/proj",
    "--add",
    "bug,ui",
  ]);
  expect(labeled.exitCode, labeled.stderr).toBe(0);
  expect(labeled.stdout).toContain(
    `labeled #${number} (added: bug, ui) — labels: bug, ui`,
  );

  const again = lh([
    "issue",
    "label",
    String(number),
    "--repo",
    "me/proj",
    "--add",
    "bug",
  ]);
  expect(again.exitCode, again.stderr).toBe(0);
  expect(again.stdout).toContain(`#${number} already had bug (no change)`);

  const json = lh([
    "issue",
    "label",
    String(number),
    "--repo",
    "me/proj",
    "--add",
    "docs",
    "--json",
  ]);
  expect(json.exitCode, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout).map((l: { name: string }) => l.name)).toEqual(
    expect.arrayContaining(["bug", "ui", "docs"]),
  );
});
