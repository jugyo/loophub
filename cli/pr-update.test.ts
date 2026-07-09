import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/prupd";

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

function createIssue(title: string, body: string): number {
  const { stdout } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    title,
    "--body",
    body,
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
  home = mkdtempSync(join(tmpdir(), "loophub-prupd-home-"));
  repoPath = mkdtempSync(join(tmpdir(), "loophub-prupd-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  // A head branch with a commit so `pr create` can resolve its SHA.
  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repoPath, "b.txt"), "y\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature work"]);
  git(["checkout", "-q", "main"]);
  git(["branch", "integration/stack"]);

  const add = lh(["repo", "add", repoPath, "--name", REPO]);
  if (add.exitCode !== 0) throw new Error(`repo add failed: ${add.stderr}`);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("lh pr update edits both title and body", () => {
  const n = createPull("old title", "old body");
  const { stdout, exitCode } = lh([
    "pr",
    "update",
    String(n),
    "--repo",
    REPO,
    "--title",
    "new title",
    "--body",
    "new body",
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`updated PR #${n}`);
  const p = viewJSON(n);
  expect(p.title).toBe("new title");
  expect(p.body).toBe("new body");
});

test("lh pr create defaults linked issue PRs to the issue target branch", () => {
  const { stdout: issueOut } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "targeted issue",
    "--target-branch",
    "integration/stack",
  ]);
  const issueMatch = issueOut.match(/created #(\d+)/);
  if (!issueMatch) throw new Error(`issue create failed: ${issueOut}`);

  const { stdout, exitCode } = lh([
    "pr",
    "create",
    "--repo",
    REPO,
    "--head",
    "feature",
    "--title",
    "targeted pr",
    "--issue",
    issueMatch[1],
  ]);

  expect(exitCode).toBe(0);
  const prMatch = stdout.match(/created PR #(\d+)/);
  if (!prMatch) throw new Error(`pr create failed: ${stdout}`);
  expect(viewJSON(Number(prMatch[1])).base.ref).toBe("integration/stack");
});

test("lh pr update --title leaves body untouched", () => {
  const n = createPull("title only", "keep this body");
  expect(
    lh(["pr", "update", String(n), "--repo", REPO, "--title", "retitled"])
      .exitCode,
  ).toBe(0);
  const p = viewJSON(n);
  expect(p.title).toBe("retitled");
  expect(p.body).toBe("keep this body");
});

test("lh pr update --body leaves title untouched", () => {
  const n = createPull("keep this title", "body only");
  expect(
    lh(["pr", "update", String(n), "--repo", REPO, "--body", "rebodied"])
      .exitCode,
  ).toBe(0);
  const p = viewJSON(n);
  expect(p.title).toBe("keep this title");
  expect(p.body).toBe("rebodied");
});

test("lh pr update without --title/--body errors", () => {
  const n = createPull("unchanged title", "unchanged body");
  const { stderr, exitCode } = lh(["pr", "update", String(n), "--repo", REPO]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("--title and/or --body is required");
  const p = viewJSON(n);
  expect(p.title).toBe("unchanged title");
  expect(p.body).toBe("unchanged body");
});

test("lh pr update on an issue number errors", () => {
  const n = createIssue("an issue", "not a pr");
  const { exitCode } = lh([
    "pr",
    "update",
    String(n),
    "--repo",
    REPO,
    "--title",
    "nope",
  ]);
  expect(exitCode).not.toBe(0);
});
