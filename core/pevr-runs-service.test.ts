import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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

test("start prepares a run, launch-step writes Plan inputs, and run update mirrors state", async () => {
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
    planPrompt: "Prefer a small plan.",
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
  expect(result.parent.user_prompt).toContain(
    `lh workflow run update --repo '${repo.full_name}' --run ${result.run.id} --step plan --status running`,
  );
  expect(result.parent.user_prompt).toContain(
    `lh workflow launch-step --repo '${repo.full_name}' --run ${result.run.id} --step plan`,
  );
  expect(result.parent.user_prompt).not.toContain(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(readFileSync(result.parent.system_prompt_path, "utf8")).toContain(
    "V1 launch-step boundary",
  );
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

  const updated = svc.pevrRuns.update(
    repo.full_name,
    {
      run: result.run.id,
      step: "execute",
      status: "running",
      reworkCount: 1,
    },
    result.session_id,
  );
  expect(updated.run).toMatchObject({
    id: result.run.id,
    current_step: "execute",
    status: "running",
    rework_count: 1,
  });
  S.createComment(issue.id, "reviewer", "Use the latest design note.");

  const launched = await svc.pevrRuns.launchStep(
    repo.full_name,
    {
      run: result.run.id,
      step: "plan",
      contract: "# Plan contract\n{{step}} {{worktreePath}} {{baseBranch}}",
      model: "sonnet",
      auto: true,
    },
    result.session_id,
  );

  expect(launched.step).toBe("plan");
  expect(launched.worktree).toBe(result.worktree);
  expect(existsSync(launched.system_prompt_path)).toBe(true);
  expect(readFileSync(launched.system_prompt_path, "utf8")).toContain(
    "step: plan",
  );
  expect(readFileSync(launched.system_prompt_path, "utf8")).toContain(
    "# Plan contract",
  );
  expect(launched.user_prompt).toContain("Prefer a small plan.");
  expect(launched.input_files).toEqual([
    expect.objectContaining({
      path: join(
        realpathSync(HOME),
        "runs",
        "pevr",
        String(result.run.id),
        "plan",
        "input",
        "task.md",
      ),
      description: "Requested outcome and acceptance criteria",
    }),
  ]);
  expect(readFileSync(launched.input_files[0].path, "utf8")).toContain(
    "Add the thing",
  );
  expect(readFileSync(launched.input_files[0].path, "utf8")).toContain(
    "Use the latest design note.",
  );
  expect(launched.herdr.argv).toContain("--split");
  expect(launched.herdr.command).toContain("LOOPHUB_PEVR_RUN=");
  expect(launched.herdr.command).toContain("LOOPHUB_PEVR_STEP='plan'");

  expect(JSON.parse(S.getPevrRun(result.run.id)!.step_sessions_json)).toEqual(
    {},
  );
  svc.pevrRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: result.run.id,
      step: launched.step,
      sessionId: launched.session_id,
      inputFiles: launched.input_files,
    },
    result.session_id,
  );
  const runAfterLaunch = S.getPevrRun(result.run.id)!;
  expect(JSON.parse(runAfterLaunch.step_sessions_json)).toEqual({
    plan: [launched.session_id],
  });
  expect(
    S.listSessionsForIssue(S.getIssue(repo.id, result.pr.number)!.id).map(
      (row) => row.id,
    ),
  ).toContain(launched.session_id);
  expect(
    S.listHandoffs(repo.id, {
      prId: S.getIssue(repo.id, result.pr.number)!.id,
    }),
  ).toEqual([
    expect.objectContaining({
      phase: "plan",
      direction: "down",
      body: expect.stringContaining("Launch PEVR plan step"),
    }),
  ]);
  const latestDir = join(
    realpathSync(HOME),
    "runs",
    "pevr",
    String(result.run.id),
    "artifacts",
    "latest",
  );
  mkdirSync(latestDir, { recursive: true });
  writeFileSync(
    join(latestDir, "plan.json"),
    JSON.stringify({
      type: "plan",
      summary: "Use the existing service layer.",
      changes: [{ area: "core/service", description: "Add launch-step" }],
      reuse: ["pevr inputs"],
      out_of_scope: ["step output"],
      verification: "Run focused tests",
    }),
  );
  writeFileSync(
    join(latestDir, "execution-report.json"),
    JSON.stringify({
      type: "execution-report",
      summary: "Implemented launch-step.",
      acceptance: [{ criterion: "launch-step", met: true, note: "Done" }],
      tests: [{ command: "npm test", passed: true, excerpt: "passed" }],
      evidence: [{ kind: "test", description: "focused tests" }],
    }),
  );
  writeFileSync(
    join(latestDir, "verdict.json"),
    JSON.stringify({
      type: "verdict",
      event: "pass",
      summary: "Looks good.",
      findings: [],
    }),
  );

  const executeLaunch = await svc.pevrRuns.launchStep(
    repo.full_name,
    {
      run: result.run.id,
      step: "execute",
      contract: "# Execute",
    },
    result.session_id,
  );
  expect(executeLaunch.input_files.map((file) => file.path)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("/execute/input/task.md"),
      expect.stringContaining("/execute/input/plan.md"),
    ]),
  );
  expect(readFileSync(executeLaunch.system_prompt_path, "utf8")).toContain(
    "# Execute",
  );

  const verifyLaunch = await svc.pevrRuns.launchStep(
    repo.full_name,
    {
      run: result.run.id,
      step: "verify",
      contract: "# Verify",
    },
    result.session_id,
  );
  expect(verifyLaunch.input_files.map((file) => file.path)).toEqual(
    expect.arrayContaining([
      expect.stringContaining("/verify/input/changes.diff"),
      expect.stringContaining("/verify/input/report.md"),
    ]),
  );

  const reflectLaunch = await svc.pevrRuns.launchStep(
    repo.full_name,
    {
      run: result.run.id,
      step: "reflect",
      contract: "# Reflect",
    },
    result.session_id,
  );
  expect(reflectLaunch.input_files.map((file) => file.path)).toEqual([
    expect.stringContaining("/reflect/input/run-digest.md"),
  ]);
});
