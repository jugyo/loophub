import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-start-home-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-start-repo-"));
const REPO = "me/workflow-start";

function run(args: string[], env: Record<string, string> = {}) {
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
        LOOPHUB_HOME: HOME,
        LOOPHUB_DB: join(HOME, "loophub.db"),
        ...env,
      },
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 0,
  };
}

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", REPO_PATH, ...args], {
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
}

beforeAll(() => {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(REPO_PATH, "README.md"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  const added = run(["repo", "add", REPO_PATH, "--name", REPO]);
  if (added.exitCode !== 0) throw new Error(added.stderr);
  const workflow = run([
    "workflow",
    "create",
    "standard",
    "--description",
    "test",
  ]);
  if (workflow.exitCode !== 0) throw new Error(workflow.stderr);
});

test("workflow step output uses flags before ambient context and supports ambient-only submission", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "PEVR output task",
    "--body",
    "Place a plan",
  ]);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);
  const started = run([
    "workflow",
    "start",
    issue,
    "--repo",
    REPO,
    "--workflow",
    "standard",
    "--no-launch",
    "--json",
  ]);
  expect(started.exitCode, started.stderr).toBe(0);
  const runResult = JSON.parse(started.stdout);
  const artifactPath = join(HOME, "plan.json");
  writeFileSync(
    artifactPath,
    JSON.stringify({
      type: "plan",
      summary: "Place the plan.",
      changes: [{ area: "core", description: "Use the service." }],
      reuse: [],
      out_of_scope: [],
      verification: "Inspect the PR body.",
    }),
  );

  const explicit = run(
    [
      "workflow",
      "step",
      "output",
      "--repo",
      REPO,
      "--run",
      String(runResult.run.id),
      "--step",
      "plan",
      "--file",
      artifactPath,
    ],
    { LOOPHUB_PEVR_RUN: "999999", LOOPHUB_PEVR_STEP: "verify" },
  );
  expect(explicit.exitCode).toBe(0);
  expect(explicit.stdout).toContain("placed pr-body-plan at pr-body");

  const ambient = run(
    ["workflow", "step", "output", "--repo", REPO, "--file", artifactPath],
    {
      LOOPHUB_PEVR_RUN: String(runResult.run.id),
      LOOPHUB_PEVR_STEP: "plan",
    },
  );
  expect(ambient.exitCode).toBe(0);
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
});

test("workflow start --no-launch creates a run and skips herdr launch", () => {
  const issueOut = run([
    "issue",
    "create",
    "--repo",
    REPO,
    "--title",
    "PEVR task",
    "--body",
    "Do it",
  ]);
  expect(issueOut.exitCode).toBe(0);
  const issue = issueOut.stdout.match(/created #(\d+)/)?.[1];
  if (!issue) throw new Error(issueOut.stdout);

  const started = run([
    "workflow",
    "start",
    issue,
    "--repo",
    REPO,
    "--workflow",
    "standard",
    "--no-launch",
    "--json",
  ]);

  expect(started.exitCode, started.stderr).toBe(0);
  const body = JSON.parse(started.stdout);
  expect(body.run).toMatchObject({
    status: "running",
    current_step: "plan",
    rework_count: 0,
  });
  expect(body.workflow.name).toBe("standard");
  expect(body.issue.number).toBe(Number(issue));
  expect(body.pr.number).toBeGreaterThan(Number(issue));
  expect(existsSync(body.worktree)).toBe(true);
  expect(existsSync(body.lock_path)).toBe(true);
  expect(body.parent.user_prompt).not.toMatch(/^\/lh-/m);
});
