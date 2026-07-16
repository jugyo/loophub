import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/cliupd";

let home: string;
let repoPath: string;

// Run the CLI against an isolated HOME/DB; no server — the CLI talks to core directly.
function lh(args: string[], env: Record<string, string> = {}) {
  const {
    HERDR_ENV: _herdrEnv,
    HERDR_PANE_ID: _herdrPaneId,
    HERDR_SESSION: _herdrSession,
    LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH: _launchId,
    LOOPHUB_WORKSPACE: _workspace,
    ...baseEnv
  } = process.env;
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
        ...baseEnv,
        LOOPHUB_HOME: home,
        LOOPHUB_DB: join(home, "loophub.db"),
        ...env,
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

function createIssueWithEnv(
  title: string,
  env: Record<string, string>,
): number {
  const result = lh(["issue", "create", "--repo", REPO, "--title", title], env);
  const match = result.stdout.match(/created #(\d+)/);
  if (!match)
    throw new Error(`create failed: ${result.stdout}\n${result.stderr}`);
  return Number(match[1]);
}

function openDb(): SqliteNS.DatabaseSync {
  return new DatabaseSync(join(home, "loophub.db"));
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

test("lh issue create defaults the target branch from LOOPHUB_WORKSPACE", () => {
  const issueNumber = createIssueWithEnv("workspace issue", {
    LOOPHUB_WORKSPACE: "integration/stack",
  });

  expect(viewJSON(issueNumber).target_branch).toBe("integration/stack");
});

test("lh issue create explicit target branch overrides LOOPHUB_WORKSPACE", () => {
  git(["branch", "workspace/explicit"]);
  const result = lh(
    [
      "issue",
      "create",
      "--repo",
      REPO,
      "--title",
      "explicit workspace issue",
      "--target-branch",
      "workspace/explicit",
    ],
    { LOOPHUB_WORKSPACE: "integration/stack" },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  const match = result.stdout.match(/created #(\d+)/);
  if (!match) throw new Error(`create failed: ${result.stdout}`);

  expect(viewJSON(Number(match[1])).target_branch).toBe("workspace/explicit");
});

test("lh issue create accepts an active registered workspace", () => {
  const workspace = lh([
    "workspace",
    "create",
    "workspace/active",
    "--repo",
    REPO,
  ]);
  expect(workspace.exitCode, workspace.stderr).toBe(0);

  const result = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "registered workspace issue",
    "--workspace",
    "workspace/active",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  const match = result.stdout.match(/created #(\d+)/);
  if (!match) throw new Error(`create failed: ${result.stdout}`);

  expect(viewJSON(Number(match[1])).target_branch).toBe("workspace/active");
});

test("lh issue create explicit workspace overrides LOOPHUB_WORKSPACE", () => {
  const workspace = lh([
    "workspace",
    "create",
    "workspace/selected",
    "--repo",
    REPO,
  ]);
  expect(workspace.exitCode, workspace.stderr).toBe(0);

  const result = lh(
    [
      "issue",
      "create",
      "--repo",
      REPO,
      "--title",
      "explicit registered workspace issue",
      "--workspace",
      "workspace/selected",
    ],
    { LOOPHUB_WORKSPACE: "integration/stack" },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  const match = result.stdout.match(/created #(\d+)/);
  if (!match) throw new Error(`create failed: ${result.stdout}`);

  expect(viewJSON(Number(match[1])).target_branch).toBe("workspace/selected");
});

test("lh issue create rejects --workspace with --target-branch", () => {
  const result = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "workspace conflict",
    "--workspace",
    "workspace/active",
    "--target-branch",
    "integration/stack",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(
    "--workspace cannot be combined with --target-branch",
  );
});

test("lh issue create rejects unregistered workspaces", () => {
  const result = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "unregistered workspace",
    "--workspace",
    "workspace/unregistered",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("active registered workspace");
});

test("lh issue create requires a value for --workspace", () => {
  const result = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "missing workspace value",
    "--workspace",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--workspace requires a value");
});

test("lh issue create rejects an empty --workspace value", () => {
  const result = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "empty workspace value",
    "--workspace=",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("workspace branch is required");
});

test("lh issue create rejects --create-target-branch as an unknown option", () => {
  const { exitCode, stderr } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "new branch target",
    "--create-target-branch",
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("unknown option: --create-target-branch");
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
  const issue = viewJSON(Number(m[1]));
  expect(issue.target_branch).toBeNull();
  expect(issue.herdr_pane).toBeNull();

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

test("lh issue create reuses a New Issue launcher pane for multiple Issues", () => {
  const env = {
    HERDR_ENV: "1",
    HERDR_SESSION: "new-issue-session",
    HERDR_PANE_ID: "w9:p1",
    LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH: "new-issue-launch",
  };
  const first = createIssueWithEnv("first from launcher", env);
  const second = createIssueWithEnv("second from launcher", env);

  expect(viewJSON(first).herdr_pane).toMatchObject({
    launch_id: "new-issue-launch",
    pane_id: "w9:p1",
    session_name: "new-issue-session",
  });
  expect(viewJSON(second).herdr_pane.launch_id).toBe("new-issue-launch");

  const db = openDb();
  try {
    const pane = db
      .prepare(
        `SELECT id, origin, lifecycle_managed
         FROM herdr_panes
         WHERE session_name = ? AND pane_id = ?`,
      )
      .all("new-issue-session", "w9:p1") as Array<{
      id: number;
      origin: string;
      lifecycle_managed: number;
    }>;
    expect(pane).toEqual([
      expect.objectContaining({
        origin: "issue-create",
        lifecycle_managed: 1,
      }),
    ]);
    expect(
      db
        .prepare(
          `SELECT r.relationship, c.released_at
           FROM herdr_pane_resources r
           JOIN herdr_pane_claims c
             ON c.pane_id = r.pane_id
            AND c.resource_kind = r.resource_kind
            AND c.resource_key = r.resource_key
           WHERE r.pane_id = ? AND r.resource_kind = 'issue'
           ORDER BY r.resource_key`,
        )
        .all(pane[0].id),
    ).toEqual([
      { relationship: "filed-from", released_at: null },
      { relationship: "filed-from", released_at: null },
    ]);
  } finally {
    db.close();
  }
});

test("lh issue create reuses a registered workflow pane without changing its origin", () => {
  const db = openDb();
  try {
    const repo = db
      .prepare("SELECT id FROM repos WHERE full_name = ?")
      .get(REPO) as { id: number };
    db.prepare(
      `INSERT INTO herdr_panes
         (repo_id, launch_id, pane_id, session_name, display_name, origin,
          lifecycle_managed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'workflow', 0, ?, ?)`,
    ).run(
      repo.id,
      "workflow-launch",
      "w8:p3",
      "workflow-session",
      "Workflow #50",
      "2026-07-14T00:00:00Z",
      "2026-07-14T00:00:00Z",
    );
  } finally {
    db.close();
  }

  const issueNumber = createIssueWithEnv("from workflow", {
    HERDR_ENV: "1",
    HERDR_SESSION: "workflow-session",
    HERDR_PANE_ID: "w8:p3",
  });
  expect(viewJSON(issueNumber).herdr_pane.launch_id).toBe("workflow-launch");

  const verifyDb = openDb();
  try {
    expect(
      verifyDb
        .prepare(
          `SELECT p.origin, p.lifecycle_managed, r.relationship
           FROM issues i
           JOIN herdr_pane_resources r
             ON r.resource_kind = 'issue' AND r.resource_key = CAST(i.id AS TEXT)
           JOIN herdr_panes p ON p.id = r.pane_id
           WHERE i.repo_id = (SELECT id FROM repos WHERE full_name = ?)
             AND i.number = ?`,
        )
        .get(REPO, issueNumber),
    ).toEqual({
      origin: "workflow",
      lifecycle_managed: 0,
      relationship: "filed-from",
    });
  } finally {
    verifyDb.close();
  }
});

test("lh issue create registers and reuses an unregistered current pane by coordinates", () => {
  const env = {
    HERDR_ENV: "1",
    HERDR_SESSION: "unregistered-session",
    HERDR_PANE_ID: "w7:p4",
  };
  const first = createIssueWithEnv("first from current pane", env);
  const second = createIssueWithEnv("second from current pane", env);
  const firstPane = viewJSON(first).herdr_pane;
  const secondPane = viewJSON(second).herdr_pane;

  expect(firstPane).toMatchObject({
    pane_id: "w7:p4",
    session_name: "unregistered-session",
  });
  expect(secondPane.launch_id).toBe(firstPane.launch_id);

  const db = openDb();
  try {
    expect(
      db
        .prepare(
          `SELECT origin, lifecycle_managed
           FROM herdr_panes
           WHERE session_name = ? AND pane_id = ?`,
        )
        .all("unregistered-session", "w7:p4"),
    ).toEqual([{ origin: "external", lifecycle_managed: 0 }]);
  } finally {
    db.close();
  }
});

test("lh issue create rejects option-like target branches", () => {
  const { stderr, exitCode } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "bad branch target",
    "--target-branch=--output=/tmp/lh-target-branch",
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("target_branch must be a local branch name");
});

test("lh issue create rejects a missing revision-expression target branch", () => {
  const { stderr, exitCode } = lh([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "revision branch target",
    "--target-branch",
    "main~1",
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain(
    "target_branch must name an existing local branch: main~1",
  );
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
