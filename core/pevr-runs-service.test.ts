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
  const parentSystemPrompt = readFileSync(
    result.parent.system_prompt_path,
    "utf8",
  );
  expect(parentSystemPrompt).toContain("step: parent");
  // The parent contract is the caller-provided template rendered verbatim — no
  // milestone boundary is appended anymore.
  expect(parentSystemPrompt).toContain("# Parent");
  expect(parentSystemPrompt).not.toContain("V1 launch-step boundary");
  expect(result.parent.user_prompt).toContain(`run: ${result.run.id}`);
  // The parent knows the domain identifiers (used for escalation); the child never does.
  expect(result.parent.user_prompt).toContain(`issue: #${result.issue.number}`);
  expect(result.parent.user_prompt).toContain(`pr: #${result.pr.number}`);
  expect(result.parent.user_prompt).toContain(
    `lh workflow run update --repo '${repo.full_name}' --run ${result.run.id} --step plan --status running`,
  );
  expect(result.parent.user_prompt).toContain(
    `lh workflow launch-step --repo '${repo.full_name}' --run ${result.run.id} --step plan`,
  );
  // Transitions are driven only by step status — the run context must say so.
  expect(result.parent.user_prompt).toContain(
    `lh workflow step status ${result.run.id} --repo '${repo.full_name}' --json`,
  );
  expect(result.parent.user_prompt).not.toContain(
    "11111111-1111-4111-8111-111111111111",
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

test("agentless e2e: step output drives all four steps to complete, then head advance makes them stale", async () => {
  const repo = S.getRepo("me", "pevr-run")!;
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Agentless run",
    "## Acceptance criteria\n- [ ] It completes\n",
    "me",
  );
  const workflow = S.createPevrWorkflow({
    name: "agentless",
    description: "",
    planPrompt: "",
    executePrompt: "",
    verifyPrompt: "",
    reflectPrompt: "",
  });
  const session = "33333333-3333-4333-8333-333333333333";
  const started = await svc.pevrRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent",
    },
    session,
  );

  // Nothing placed yet: every step incomplete.
  const initial = await svc.pevrRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(initial.steps.plan.complete).toBe(false);
  expect(initial.steps.execute.missing).toEqual([
    "no validated execution-report for current head",
    "head equals base",
  ]);
  expect(initial.steps.verify.latest_verdict).toBeNull();

  // step input is a dry-run window: same composition, no session/handoff created.
  const handoffsBefore = S.listHandoffs(repo.id, {
    prId: S.getIssue(repo.id, started.pr.number)!.id,
  }).length;
  const dryRun = await svc.pevrRuns.stepInput(repo.full_name, {
    run: started.run.id,
    step: "plan",
    contract: "# Plan contract\n{{step}} {{worktreePath}} {{baseBranch}}",
  });
  expect(dryRun.system_prompt).toContain("# Plan contract");
  expect(dryRun.user_prompt).toContain("## Inputs");
  expect(dryRun.input_files.map((f) => f.path)).toEqual([
    expect.stringContaining("/plan/input/task.md"),
  ]);
  expect(JSON.parse(S.getPevrRun(started.run.id)!.step_sessions_json)).toEqual(
    {},
  );
  expect(
    S.listHandoffs(repo.id, {
      prId: S.getIssue(repo.id, started.pr.number)!.id,
    }).length,
  ).toBe(handoffsBefore);

  // Plan.
  await svc.pevrRuns.stepOutput(
    repo.full_name,
    {
      run: started.run.id,
      step: "plan",
      content: JSON.stringify({
        type: "plan",
        summary: "Plan it.",
        changes: [{ area: "core", description: "Do it." }],
        reuse: [],
        out_of_scope: [],
        verification: "Tests.",
      }),
    },
    session,
  );
  expect(
    (await svc.pevrRuns.status(repo.full_name, { run: started.run.id })).steps
      .plan.complete,
  ).toBe(true);

  // Execute needs a commit so the head is ahead of base.
  writeFileSync(join(started.worktree, "impl.txt"), "work\n");
  gitAt(started.worktree, ["add", "impl.txt"]);
  gitAt(started.worktree, ["commit", "-m", "Implement"]);
  const executeHead = gitAt(started.worktree, ["rev-parse", "HEAD"]);
  await svc.pevrRuns.stepOutput(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      content: JSON.stringify({
        type: "execution-report",
        summary: "Implemented.",
        acceptance: [{ criterion: "It completes", met: true, note: "Done." }],
        tests: [{ command: "npm test", passed: true, excerpt: "1 passed" }],
        evidence: [{ kind: "test", description: "focused tests" }],
      }),
    },
    session,
  );
  const afterExecute = await svc.pevrRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(afterExecute.steps.execute).toEqual({ complete: true, missing: [] });

  // Verify (submitted by the parent session, stamped at current head).
  await svc.pevrRuns.stepOutput(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      content: JSON.stringify({
        type: "verdict",
        event: "pass",
        summary: "AC satisfied.",
        findings: [],
      }),
    },
    session,
  );
  const afterVerify = await svc.pevrRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(afterVerify.steps.verify.complete).toBe(true);
  expect(afterVerify.steps.verify.latest_verdict).toEqual({
    event: "pass",
    summary: "AC satisfied.",
    findings: [],
  });

  // Reflect.
  await svc.pevrRuns.stepOutput(
    repo.full_name,
    {
      run: started.run.id,
      step: "reflect",
      content: JSON.stringify({
        type: "reflection",
        went_well: ["Composition works"],
        friction: [],
        suggestions: [],
        followups: [],
      }),
    },
    session,
  );
  const allComplete = await svc.pevrRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(Object.values(allComplete.steps).every((s) => s.complete)).toBe(true);

  // Advancing the head makes execution-report and verdict stale (both were
  // stamped at executeHead, not the new head).
  writeFileSync(join(started.worktree, "impl.txt"), "more work\n");
  gitAt(started.worktree, ["add", "impl.txt"]);
  gitAt(started.worktree, ["commit", "-m", "Advance head"]);
  expect(gitAt(started.worktree, ["rev-parse", "HEAD"])).not.toBe(executeHead);
  const stale = await svc.pevrRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(stale.steps.execute.complete).toBe(false);
  expect(stale.steps.execute.missing).toContain(
    "no validated execution-report for current head",
  );
  expect(stale.steps.verify.complete).toBe(false);
  expect(stale.steps.verify.missing).toEqual([
    "no validated verdict for current head",
  ]);
  // Plan and reflect are head-independent, so they stay complete.
  expect(stale.steps.plan.complete).toBe(true);
  expect(stale.steps.reflect.complete).toBe(true);
  // The latest verdict summary survives staleness for the parent's rework read.
  expect(stale.steps.verify.latest_verdict?.event).toBe("pass");
}, 20_000);

test("parent contract template specifies transitions, rework, and escalation", () => {
  const contract = readFileSync(
    join(import.meta.dirname, "pevr", "contracts", "parent.md"),
    "utf8",
  );
  // AC: allowed LoopHub / herdr commands are listed.
  expect(contract).toContain("lh workflow run update");
  expect(contract).toContain("lh workflow launch-step");
  expect(contract).toContain("lh workflow step status");
  expect(contract).toContain("herdr pane run");
  // AC: transitions are driven only by step status, not pane output / PR markers.
  expect(contract).toContain(
    "Transitions are driven only by `lh workflow step status`",
  );
  expect(contract).toMatch(/never use pane output|PR body marker/i);
  // AC: the full step transition table.
  expect(contract).toContain("plan complete");
  expect(contract).toContain("execute complete");
  expect(contract).toContain("verdict `pass`");
  expect(contract).toContain("verdict `request_changes`");
  expect(contract).toContain("--status completed");
  // AC: rework increments the count, caps at 3, and restarts Execute; Verify is always fresh.
  expect(contract).toContain("--rework-count");
  expect(contract).toContain("would exceed 3");
  expect(contract).toContain("--step execute");
  expect(contract).toContain("Verify as a fresh child");
  // AC: escalation via issue comment + inbox + run blocked.
  expect(contract).toContain("lh issue comment");
  expect(contract).toContain("lh inbox send");
  expect(contract).toContain("--status blocked");
  // AC: skill independence — the contract forbids slash commands.
  expect(contract).toContain("Do not call slash commands");
});

test("stateForIssue / stateForPull expose run display state, or null when absent (#1008)", async () => {
  const repo = S.createRepo("me/pevr-state", REPO_PATH);
  const issue = S.createIssue(repo.id, "issue", "Show run state", "body", "me");
  const workflow = S.createPevrWorkflow({
    name: "state-wf",
    description: "",
    planPrompt: "",
    executePrompt: "",
    verifyPrompt: "",
    reflectPrompt: "",
  });

  // No run yet -> both lookups return null.
  expect(
    await svc.pevrRuns.stateForIssue(repo.full_name, { issue: issue.number }),
  ).toBeNull();
  expect(
    await svc.pevrRuns.stateForPull(repo.full_name, { pull: 4242 }),
  ).toBeNull();

  const run = S.createPevrRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: 4242,
    status: "running",
    currentStep: "verify",
    parentSessionId: "22222222-2222-4222-8222-222222222222",
  });
  S.updatePevrRun(run.id, { reworkCount: 2 });

  // A request_changes verdict artifact is surfaced as the display reason.
  const verdict = {
    type: "verdict" as const,
    event: "request_changes" as const,
    summary: "Two acceptance criteria are unmet.",
    findings: [
      { file: "a.ts", problem: "missing guard", expected: "guard added" },
      { file: "b.ts", problem: "no test", expected: "test added" },
    ],
  };
  S.createPevrArtifact({
    runId: run.id,
    step: "verify",
    type: "verdict",
    contentJson: JSON.stringify(verdict),
    headSha: "0".repeat(40),
    submittedBy: "22222222-2222-4222-8222-222222222222",
    dedupeKey: "state-wf-verdict-1",
  });

  const byIssue = await svc.pevrRuns.stateForIssue(repo.full_name, {
    issue: issue.number,
  });
  expect(byIssue).toMatchObject({
    id: run.id,
    workflow_id: workflow.id,
    workflow_name: "state-wf",
    status: "running",
    current_step: "verify",
    rework_count: 2,
    issue_number: issue.number,
    pr_number: 4242,
  });
  expect(byIssue?.latest_verdict).toEqual({
    event: "request_changes",
    summary: "Two acceptance criteria are unmet.",
    findings_count: 2,
  });

  const byPull = await svc.pevrRuns.stateForPull(repo.full_name, {
    pull: 4242,
  });
  expect(byPull?.id).toBe(run.id);
  expect(byPull?.workflow_name).toBe("state-wf");
});
