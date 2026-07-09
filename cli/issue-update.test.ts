import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/cliupd";

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
  if (!m) throw new Error(`create failed: ${stdout}`);
  return Number(m[1]);
}

function viewJSON(n: number) {
  const { stdout } = lh(["issue", "view", String(n), "--repo", REPO, "--json"]);
  return JSON.parse(stdout);
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "loophub-cliupd-home-"));
  repoPath = mkdtempSync(join(tmpdir(), "loophub-cliupd-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["branch", "integration/stack"]);

  const add = lh(["repo", "add", repoPath, "--name", REPO]);
  if (add.exitCode !== 0) throw new Error(`repo add failed: ${add.stderr}`);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("lh issue update edits both title and body", () => {
  const n = createIssue("old title", "old body");
  const { stdout, exitCode } = lh([
    "issue",
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
  expect(stdout).toContain(`updated #${n}`);
  const i = viewJSON(n);
  expect(i.title).toBe("new title");
  expect(i.body).toBe("new body");
});

test("lh issue create accepts a target branch", () => {
  const { stdout } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "targeted issue",
    "--target-branch",
    "integration/stack",
  ]);
  const m = stdout.match(/created #(\d+)/);
  if (!m) throw new Error(`create failed: ${stdout}`);

  const issue = viewJSON(Number(m[1]));
  expect(issue.target_branch).toBe("integration/stack");
});

test("lh issue create can create a missing target branch from default", () => {
  const { stdout, exitCode, stderr } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "new branch target",
    "--target-branch",
    "feature/issue-target",
    "--create-target-branch",
  ]);
  expect(exitCode).toBe(0);
  const m = stdout.match(/created #(\d+)/);
  if (!m) throw new Error(`create failed: ${stdout}\n${stderr}`);

  const issue = viewJSON(Number(m[1]));
  expect(issue.target_branch).toBe("feature/issue-target");
  const branch = spawnSync(
    "git",
    [
      "-C",
      repoPath,
      "show-ref",
      "--verify",
      "--quiet",
      "refs/heads/feature/issue-target",
    ],
    { encoding: "utf8" },
  );
  expect(branch.status).toBe(0);
});

test("lh issue create without target branch does not create a branch", () => {
  const { stdout, exitCode } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "plain issue",
  ]);
  expect(exitCode).toBe(0);
  const m = stdout.match(/created #(\d+)/);
  if (!m) throw new Error(`create failed: ${stdout}`);
  expect(viewJSON(Number(m[1])).target_branch).toBeNull();

  const branch = spawnSync(
    "git",
    [
      "-C",
      repoPath,
      "show-ref",
      "--verify",
      "--quiet",
      "refs/heads/plain-issue",
    ],
    { encoding: "utf8" },
  );
  expect(branch.status).not.toBe(0);
});

test("lh issue create rejects invalid create-if-missing target branches", () => {
  const { stderr, exitCode } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "bad branch target",
    "--target-branch=--output=/tmp/lh-target-branch",
    "--create-target-branch",
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("target_branch must be a local branch name");
});

test("lh issue create rejects revision-expression target branches", () => {
  const { stderr, exitCode } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "revision branch target",
    "--target-branch",
    "main~1",
    "--create-target-branch",
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("target_branch must be a local branch name");
});

test("lh issue create rejects revision-special target branches", () => {
  git(["branch", "@"]);
  const { stderr, exitCode } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "special branch target",
    "--target-branch",
    "@",
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("target_branch must be a local branch name");
});

test("lh issue update --title leaves body untouched", () => {
  const n = createIssue("title only", "keep this body");
  expect(
    lh(["issue", "update", String(n), "--repo", REPO, "--title", "retitled"])
      .exitCode,
  ).toBe(0);
  const i = viewJSON(n);
  expect(i.title).toBe("retitled");
  expect(i.body).toBe("keep this body");
});

test("lh issue update --body leaves title untouched", () => {
  const n = createIssue("keep this title", "body only");
  expect(
    lh(["issue", "update", String(n), "--repo", REPO, "--body", "rebodied"])
      .exitCode,
  ).toBe(0);
  const i = viewJSON(n);
  expect(i.title).toBe("keep this title");
  expect(i.body).toBe("rebodied");
});

test("lh issue update without --title/--body errors", () => {
  const n = createIssue("unchanged title", "unchanged body");
  const { stderr, exitCode } = lh([
    "issue",
    "update",
    String(n),
    "--repo",
    REPO,
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("--title and/or --body is required");
  const i = viewJSON(n);
  expect(i.title).toBe("unchanged title");
  expect(i.body).toBe("unchanged body");
});
