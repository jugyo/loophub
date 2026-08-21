import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/prghpr";

let home: string;
let repoPath: string;

// Run the CLI against an isolated HOME/DB; no server — the CLI talks to core directly.
function lh(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LOOPHUB_HOME: home,
      LOOPHUB_DB: join(home, "loophub.db"),
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

function createPull(title: string, body: string): number {
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
    title,
    "--body",
    body,
  ]);
  const m = stdout.match(/created PR #(\d+)/);
  if (!m) throw new Error(`pr create failed: ${stdout}`);
  return Number(m[1]);
}

function viewJSON(n: number) {
  const { stdout } = lh(["pr", "view", String(n), "--repo", REPO, "--json"]);
  return JSON.parse(stdout);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "loophub-prghpr-home-"));
  repoPath = mkdtempSync(join(tmpdir(), "loophub-prghpr-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["remote", "add", "origin", "https://github.com/me/prghpr.git"]);
  // A head branch with a commit so `pr create` can resolve its SHA.
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

test("lh pr record-github-pr attaches a URL without --number (#487)", () => {
  const n = createPull("backfill me", "body");
  const { stdout, exitCode } = lh([
    "pr",
    "record-github-pr",
    String(n),
    "--repo",
    REPO,
    "--url",
    "https://github.com/me/prghpr/pull/2764",
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("recorded GitHub PR #2764");
  const p = viewJSON(n);
  expect(p.github_pull).toMatchObject({
    number: 2764,
    url: "https://github.com/me/prghpr/pull/2764",
  });
});

test("lh pr record-github-pr is idempotent and re-linking overwrites (#487)", () => {
  const n = createPull("re-link me", "body");
  lh([
    "pr",
    "record-github-pr",
    String(n),
    "--repo",
    REPO,
    "--url",
    "https://github.com/me/prghpr/pull/1",
  ]);
  const second = lh([
    "pr",
    "record-github-pr",
    String(n),
    "--repo",
    REPO,
    "--url",
    "https://github.com/me/prghpr/pull/2",
  ]);
  expect(second.exitCode).toBe(0);
  const p = viewJSON(n);
  expect(p.github_pull.number).toBe(2);
});

test("lh pr record-github-pr without --url errors", () => {
  const n = createPull("no url", "body");
  const { stderr, exitCode } = lh([
    "pr",
    "record-github-pr",
    String(n),
    "--repo",
    REPO,
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("--url is required");
  const p = viewJSON(n);
  expect(p.github_pull).toBeNull();
});

test("lh pr record-github-pr rejects a url with no derivable PR number", () => {
  const n = createPull("bad url", "body");
  const { stderr, exitCode } = lh([
    "pr",
    "record-github-pr",
    String(n),
    "--repo",
    REPO,
    "--url",
    "https://github.com/me/prghpr",
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("github_number");
});
