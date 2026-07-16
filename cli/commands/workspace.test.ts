import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "..", "index.ts");
const home = mkdtempSync(join(tmpdir(), "lh-workspace-cli-home-"));
const repoPath = mkdtempSync(join(tmpdir(), "lh-workspace-cli-repo-"));

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

test("lh workspace creates, lists, and archives a branch-backed workspace", () => {
  const created = lh([
    "workspace",
    "create",
    "integration/cli",
    "--repo",
    "me/proj",
  ]);
  expect(created.exitCode, created.stderr).toBe(0);
  expect(created.stdout).toContain("created integration/cli");

  const listed = lh(["workspace", "list", "--repo", "me/proj"]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect(listed.stdout).toContain("integration/cli\tbranch_exists=true");

  git(["branch", "-D", "integration/cli"]);
  const missing = lh(["workspace", "list", "--repo", "me/proj", "--json"]);
  expect(missing.exitCode, missing.stderr).toBe(0);
  expect(JSON.parse(missing.stdout)).toContainEqual(
    expect.objectContaining({
      branch: "integration/cli",
      branch_exists: false,
    }),
  );

  const archived = lh([
    "workspace",
    "archive",
    "integration/cli",
    "--repo",
    "me/proj",
  ]);
  expect(archived.exitCode, archived.stderr).toBe(0);
  expect(archived.stdout).toContain("archived integration/cli");
  expect(lh(["workspace", "list", "--repo", "me/proj"]).stdout).not.toContain(
    "integration/cli",
  );
});

test("CLI usage distinguishes workspaces from worktrees", () => {
  const result = lh([]);

  expect(result.stdout).toContain(
    "workspace = integration branch; worktree = PR checkout",
  );
});
