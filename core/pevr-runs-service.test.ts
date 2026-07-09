import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-pevr-runs-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-pevr-runs-repo-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", REPO_PATH, ...args], {
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) {
    throw new Error(result.stderr);
  }
}

beforeAll(async () => {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(REPO_PATH, "README.md"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  svc = await import("./service.ts");
  S = await import("./store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
});

test("start prepares a running PEVR run without launching the parent", async () => {
  const repo = S.createRepo("me/pevr-run", REPO_PATH);
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Add the thing",
    "## Acceptance criteria\n- [ ] It works\n",
    "me",
  );
  const workflow = S.createPevrWorkflow({
    name: "standard",
    description: "",
    planPrompt: "",
    executePrompt: "",
    verifyPrompt: "",
    reflectPrompt: "",
  });

  const result = await svc.pevrRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent\nDo the run.",
    },
    "11111111-1111-4111-8111-111111111111",
  );

  expect(result.run).toMatchObject({
    workflow_id: workflow.id,
    status: "running",
    current_step: "plan",
    rework_count: 0,
    parent_session_id: "11111111-1111-4111-8111-111111111111",
  });
  expect(result.pr.number).toBeGreaterThan(issue.number);
  expect(existsSync(result.worktree)).toBe(true);
  expect(existsSync(result.lock_path)).toBe(true);
  expect(readFileSync(result.parent.system_prompt_path, "utf8")).toContain(
    "step: parent",
  );
  expect(result.parent.user_prompt).toContain(`run: ${result.run.id}`);
  expect(result.parent.user_prompt).not.toMatch(/^\/lh-/m);

  const row = S.getPevrRun(result.run.id);
  expect(row).toMatchObject({
    status: "running",
    current_step: "plan",
    rework_count: 0,
  });
  expect(
    S.primaryDevSessionForPull(S.getIssue(repo.id, result.pr.number)!.id),
  ).toBe("11111111-1111-4111-8111-111111111111");
});
