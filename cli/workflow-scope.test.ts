import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-scope-home-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-scope-repo-"));

function lh(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LOOPHUB_HOME: HOME,
      LOOPHUB_DB: join(HOME, "loophub.db"),
    },
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

beforeAll(() => {
  const git = spawnSync("git", ["-C", REPO_PATH, "init", "-q", "-b", "main"], {
    encoding: "utf8",
  });
  expect(git.status, git.stderr).toBe(0);
  const registered = lh(["repo", "add", REPO_PATH, "--name", "me/proj"]);
  expect(registered.exitCode, registered.stderr).toBe(0);
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
});

test("workflow commands manage same-name definitions in separate scopes", () => {
  const global = lh(["workflow", "create", "Standard", "--json"]);
  expect(global.exitCode, global.stderr).toBe(0);
  const scoped = lh([
    "workflow",
    "create",
    "Standard",
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(scoped.exitCode, scoped.stderr).toBe(0);
  const scopedWorkflow = JSON.parse(scoped.stdout);
  expect(scopedWorkflow.scope).toMatchObject({
    kind: "repository",
    repo: { owner: "me", name: "proj" },
  });

  const listed = lh(["workflow", "list", "--repo", "me/proj", "--json"]);
  expect(
    JSON.parse(listed.stdout).map((workflow: { id: number }) => workflow.id),
  ).toEqual([scopedWorkflow.id]);

  const updated = lh([
    "workflow",
    "update",
    "--workflow-id",
    String(scopedWorkflow.id),
    "--description",
    "Repository loop",
    "--json",
  ]);
  expect(updated.exitCode, updated.stderr).toBe(0);
  expect(JSON.parse(updated.stdout).description).toBe("Repository loop");

  const archived = lh([
    "workflow",
    "archive",
    "--workflow-id",
    String(scopedWorkflow.id),
    "--json",
  ]);
  expect(archived.exitCode, archived.stderr).toBe(0);
  expect(JSON.parse(archived.stdout).archived_at).toBeTruthy();
});
