import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/prcomment";

let home: string;
let repoPath: string;

// Run the CLI against an isolated HOME/DB; no server — the CLI talks to core directly.
function lh(args: string[]) {
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
      },
    },
  );
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

function createPull(): number {
  const { stdout } = lh([
    "pr",
    "create",
    "--repo",
    REPO,
    "--head",
    "feature",
    "--base",
    "main",
    "--title",
    "comment target",
    "--body",
    "body",
  ]);
  const m = stdout.match(/created PR #(\d+)/);
  if (!m) throw new Error(`pr create failed: ${stdout}`);
  return Number(m[1]);
}

function createIssue(): number {
  const { stdout } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "not a pull",
    "--body",
    "body",
  ]);
  const m = stdout.match(/created #(\d+)/);
  if (!m) throw new Error(`issue create failed: ${stdout}`);
  return Number(m[1]);
}

function viewJSON(n: number) {
  const { stdout } = lh(["pr", "view", String(n), "--repo", REPO, "--json"]);
  return JSON.parse(stdout);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "loophub-prcomment-home-"));
  repoPath = mkdtempSync(join(tmpdir(), "loophub-prcomment-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repoPath, "b.txt"), "y\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature work"]);
  git(["checkout", "-q", "main"]);

  const add = lh(["repo", "add", repoPath, "--name", REPO]);
  if (add.exitCode !== 0) throw new Error(`repo add failed: ${add.stderr}`);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("lh pr comment posts a plain comment on a PR", () => {
  const n = createPull();
  const { stdout, exitCode } = lh([
    "pr",
    "comment",
    String(n),
    "--repo",
    REPO,
    "--body",
    "plain progress note",
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("commented");
  expect(viewJSON(n).comments).toBe(1);
});

test("lh pr comment requires a body", () => {
  const n = createPull();
  const { stderr, exitCode } = lh(["pr", "comment", String(n), "--repo", REPO]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("body is required");
  expect(viewJSON(n).comments).toBe(0);
});

test("lh pr comment rejects issue numbers", () => {
  const n = createIssue();
  const { stderr, exitCode } = lh([
    "pr",
    "comment",
    String(n),
    "--repo",
    REPO,
    "--body",
    "wrong target",
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("Not Found");
});

test("usage lists the pr comment subcommand", () => {
  const { stdout, exitCode } = lh([]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("lh pr list|view|diff|create|update|comment|merge");
  expect(stdout).toContain('lh pr comment 3 --body "starting work"');
});
