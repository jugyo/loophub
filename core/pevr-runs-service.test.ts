import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
let D: typeof import("./db.ts");

function git(args: string[]): void {
  const result = spawnSync("git", ["-C", REPO_PATH, ...args], {
    encoding: "utf8",
  });
  if ((result.status ?? 0) !== 0) {
    throw new Error(result.stderr);
  }
}

function gitAt(path: string, args: string[]): string {
  const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
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
  D = await import("./db.ts");
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
  const headSha = gitAt(result.worktree, ["rev-parse", "HEAD"]);
  for (const [step, artifact] of [
    [
      "plan",
      {
        type: "plan",
        summary: "Use the existing service layer.",
        changes: [{ area: "core/service", description: "Add launch-step" }],
        reuse: ["pevr inputs"],
        out_of_scope: ["step output"],
        verification: "Run focused tests",
      },
    ],
    [
      "execute",
      {
        type: "execution-report",
        summary: "Implemented launch-step.",
        acceptance: [{ criterion: "launch-step", met: true, note: "Done" }],
        tests: [{ command: "npm test", passed: true, excerpt: "passed" }],
        evidence: [{ kind: "test", description: "focused tests" }],
      },
    ],
    [
      "verify",
      {
        type: "verdict",
        event: "pass",
        summary: "Looks good.",
        findings: [],
      },
    ],
  ] as const) {
    const contentJson = JSON.stringify(artifact);
    S.createPevrArtifact({
      runId: result.run.id,
      step,
      type: artifact.type,
      contentJson,
      headSha,
      submittedBy: result.session_id,
      dedupeKey: `${result.run.id}-${step}`,
    });
  }

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

test("step output validates, stamps, places, readies, and retries an accepted artifact", async () => {
  const repo = S.getRepo("me", "pevr-run")!;
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Place PEVR output",
    "## Acceptance criteria\n- [ ] It is placed\n",
    "me",
  );
  const workflow = S.createPevrWorkflow({
    name: "output-test",
    description: "",
    planPrompt: "",
    executePrompt: "",
    verifyPrompt: "",
    reflectPrompt: "",
  });
  const started = await svc.pevrRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent",
    },
    "22222222-2222-4222-8222-222222222222",
  );

  await expect(
    svc.pevrRuns.stepOutput(
      repo.full_name,
      { run: started.run.id, step: "plan", content: "{" },
      started.session_id,
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(S.latestPevrArtifact(started.run.id, "plan")).toBeNull();
  await expect(
    svc.pevrRuns.stepOutput(
      repo.full_name,
      {
        run: started.run.id,
        step: "execute",
        content: JSON.stringify({
          type: "plan",
          summary: "Wrong step.",
          changes: [{ area: "core", description: "Noop." }],
          reuse: [],
          out_of_scope: [],
          verification: "None.",
        }),
      },
      started.session_id,
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(S.latestPevrArtifact(started.run.id, "execute")).toBeNull();

  const plan = JSON.stringify({
    type: "plan",
    summary: "Implement placement.",
    changes: [{ area: "core", description: "Add placement." }],
    reuse: ["pull service"],
    out_of_scope: [],
    verification: "Run tests.",
  });
  const outsideArtifacts = join(HOME, "outside-artifacts");
  mkdirSync(outsideArtifacts);
  const artifactDirectory = join(
    HOME,
    "runs",
    "pevr",
    String(started.run.id),
    "artifacts",
  );
  symlinkSync(outsideArtifacts, artifactDirectory);
  const placedPlan = await svc.pevrRuns.stepOutput(
    repo.full_name,
    { run: started.run.id, step: "plan", content: plan },
    started.session_id,
  );
  expect(existsSync(join(outsideArtifacts, "latest", "plan.json"))).toBe(false);
  rmSync(artifactDirectory);
  expect(placedPlan.placement).toEqual({
    kind: "pr-body-plan",
    ref: "pr-body",
  });
  expect(placedPlan.retried).toBe(false);
  expect(placedPlan.head_sha).toBe(
    gitAt(started.worktree, ["rev-parse", "HEAD"]),
  );
  expect(
    (await svc.pulls.get(repo.full_name, started.pr.number)).body,
  ).toContain("## Implementation plan");

  const missingScreenshot = "later.png";
  const report = JSON.stringify({
    type: "execution-report",
    summary: "Implemented placement.",
    acceptance: [{ criterion: "It is placed", met: true, note: "Implemented" }],
    tests: [{ command: "npm test", passed: true, excerpt: "1 passed" }],
    evidence: [
      {
        kind: "cli",
        description: "Placement result",
        path: missingScreenshot,
      },
    ],
  });
  await expect(
    svc.pevrRuns.stepOutput(
      repo.full_name,
      { run: started.run.id, step: "execute", content: report },
      started.session_id,
    ),
  ).rejects.toThrow();
  const accepted = S.latestPevrArtifact(started.run.id, "execute")!;
  expect(S.getPevrPlacement(accepted.id)).toBeNull();
  const firstClaim = S.claimPevrPlacement(accepted.id);
  expect(firstClaim).toEqual(expect.any(String));
  expect(S.claimPevrPlacement(accepted.id)).toBeNull();
  D.db.run(
    `UPDATE pevr_placement_claims SET claimed_at = ? WHERE artifact_id = ?`,
    ["2000-01-01T00:00:00.000Z", accepted.id],
  );
  const replacementClaim = S.claimPevrPlacement(accepted.id);
  expect(replacementClaim).toEqual(expect.any(String));
  expect(S.renewPevrPlacementClaim(accepted.id, replacementClaim!)).toBe(true);
  S.releasePevrPlacementClaim(accepted.id, firstClaim!);
  expect(S.claimPevrPlacement(accepted.id)).toBeNull();
  S.releasePevrPlacementClaim(accepted.id, replacementClaim!);

  writeFileSync(join(started.worktree, missingScreenshot), "png bytes");
  writeFileSync(
    join(started.worktree, "README.md"),
    "head changed before retry\n",
  );
  gitAt(started.worktree, ["add", "README.md"]);
  gitAt(started.worktree, ["commit", "-m", "Advance before retry"]);
  const retried = await svc.pevrRuns.stepOutput(
    repo.full_name,
    { run: started.run.id, step: "execute", content: report },
    started.session_id,
  );
  expect(retried).toMatchObject({ artifact_id: accepted.id, retried: true });
  expect(retried.head_sha).toBe(accepted.head_sha);
  const pull = await svc.pulls.get(repo.full_name, started.pr.number);
  expect(pull.draft).toBe(false);
  expect(pull.body).toContain("![later.png](/attachments/");
  expect(S.getPevrPlacement(accepted.id)?.target_kind).toBe("pr-body-report");
  const duplicate = await svc.pevrRuns.stepOutput(
    repo.full_name,
    { run: started.run.id, step: "execute", content: report },
    started.session_id,
  );
  expect(duplicate.artifact_id).not.toBe(accepted.id);
  expect(duplicate.retried).toBe(false);

  const verifyLaunch = await svc.pevrRuns.launchStep(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      contract: "# Verify",
      model: "sonnet",
    },
    started.session_id,
  );
  const pinnedHead = gitAt(started.worktree, ["rev-parse", "HEAD"]);
  rmSync(join(started.worktree, missingScreenshot));
  writeFileSync(join(started.worktree, "README.md"), "new head\n");
  gitAt(started.worktree, ["add", "README.md"]);
  gitAt(started.worktree, ["commit", "-m", "Advance head"]);
  expect(gitAt(started.worktree, ["rev-parse", "HEAD"])).not.toBe(pinnedHead);
  const secondVerifyLaunch = await svc.pevrRuns.launchStep(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      contract: "# Verify again",
      model: "sonnet",
    },
    started.session_id,
  );
  const confirmed = svc.pevrRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      sessionId: verifyLaunch.session_id,
      inputFiles: verifyLaunch.input_files,
      headSha: verifyLaunch.head_sha,
    },
    started.session_id,
  );
  svc.pevrRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      sessionId: secondVerifyLaunch.session_id,
      inputFiles: secondVerifyLaunch.input_files,
      headSha: secondVerifyLaunch.head_sha,
    },
    started.session_id,
  );
  const verdict = await svc.pevrRuns.stepOutput(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      content: JSON.stringify({
        type: "verdict",
        event: "pass",
        summary: "Pinned revision passes.",
        findings: [],
      }),
    },
    confirmed.session_id,
  );
  expect(verdict.head_sha).toBe(pinnedHead);
  expect(verdict.placement.kind).toBe("review");
  D.db.run(`UPDATE pevr_step_pins SET head_sha = ? WHERE session_id = ?`, [
    "not-a-sha",
    secondVerifyLaunch.session_id,
  ]);
  await expect(
    svc.pevrRuns.stepOutput(
      repo.full_name,
      {
        run: started.run.id,
        step: "verify",
        content: JSON.stringify({
          type: "verdict",
          event: "pass",
          summary: "Invalid pin must fail.",
          findings: [],
        }),
      },
      secondVerifyLaunch.session_id,
    ),
  ).rejects.toMatchObject({ status: 422 });

  D.db.run(`UPDATE pevr_step_pins SET head_sha = ? WHERE session_id = ?`, [
    secondVerifyLaunch.head_sha,
    secondVerifyLaunch.session_id,
  ]);
  const crossSessionContent = JSON.stringify({
    type: "verdict",
    event: "pass",
    summary: "Same JSON from another session.",
    findings: [],
  });
  const firstSessionArtifact = S.createPevrArtifact({
    runId: started.run.id,
    step: "verify",
    type: "verdict",
    contentJson: crossSessionContent,
    headSha: pinnedHead,
    submittedBy: confirmed.session_id,
    dedupeKey: "cross-session-a",
  });
  const secondSessionVerdict = await svc.pevrRuns.stepOutput(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      content: crossSessionContent,
    },
    secondVerifyLaunch.session_id,
  );
  expect(secondSessionVerdict.artifact_id).not.toBe(firstSessionArtifact.id);
  expect(secondSessionVerdict.head_sha).toBe(secondVerifyLaunch.head_sha);

  svc.pevrRuns.update(
    repo.full_name,
    { run: started.run.id, status: "stopped" },
    started.session_id,
  );
  await expect(
    svc.pevrRuns.stepOutput(
      repo.full_name,
      { run: started.run.id, step: "reflect", content: "{}" },
      started.session_id,
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(S.latestPevrArtifact(started.run.id, "reflect")).toBeNull();
}, 15_000);
