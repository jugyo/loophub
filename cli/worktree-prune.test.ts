import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/worktree-prune";

let home: string;
let repoPath: string;

function lh(args: string[], tty = false) {
  const nodeArgs = [
    "--experimental-sqlite",
    "--disable-warning=ExperimentalWarning",
    "--import",
    "tsx",
    ...(tty
      ? [
          "--input-type=module",
          "--eval",
          `Object.defineProperty(process.stderr, "isTTY", { value: true }); process.argv = ${JSON.stringify([process.execPath, CLI, ...args])}; await import(${JSON.stringify(pathToFileURL(CLI).href)});`,
        ]
      : [CLI, ...args]),
  ];
  const result = spawnSync(process.execPath, nodeArgs, {
    encoding: "utf8",
    env: {
      ...process.env,
      LOOPHUB_HOME: home,
      LOOPHUB_DB: join(home, "loophub.db"),
    },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 0,
  };
}

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "lh-worktree-prune-home-"));
  repoPath = mkdtempSync(join(tmpdir(), "lh-worktree-prune-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "README.md"), "test\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "init"]);

  const added = lh(["repo", "add", repoPath, "--name", REPO]);
  if (added.exitCode !== 0) throw new Error(added.stderr);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe("worktree prune loading display", () => {
  test.each([
    ["all registered repositories", []],
    ["a repository selected with --repo", ["--repo", REPO]],
  ])("shows and clears while scanning %s", (_label, repoArgs) => {
    const result = lh(
      ["worktree", "prune", ...repoArgs, "--dry-run", "--yes", "--force"],
      true,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("Scanning worktrees...");
    expect(result.stderr).toContain("\r\u001b[2K");
    expect(result.stdout).toContain("Remove candidates (0):");
    expect(result.stdout).toContain("dry-run: nothing removed.");
  });

  test("keeps --json stdout machine-readable and omits loading output", () => {
    const result = lh(
      ["worktree", "prune", "--repo", REPO, "--dry-run", "--json"],
      true,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      candidates: [],
      keep: [],
      skip: [],
      dryRun: true,
    });
  });

  test("clears the loading display before reporting a planning failure", () => {
    const result = lh(
      ["worktree", "prune", "--repo", "missing/repo", "--dry-run"],
      true,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Scanning worktrees...");
    const clearAt = result.stderr.indexOf("\r\u001b[2K");
    const errorAt = result.stderr.indexOf("error 404:");
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeGreaterThan(clearAt);
  });
});
