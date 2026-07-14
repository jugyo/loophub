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

const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-runs-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-runs-repo-"));
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

test("start prepares a run and launch-step writes Execute inputs", async () => {
  const repo = S.createRepo("me/workflow-run", REPO_PATH);
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Add the thing",
    "## Acceptance criteria\n- [ ] It works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "standard",
    description: "",
    executePrompt: "Plan and implement a small change.",
    verifyPrompt: "",
  });
  S.createComment(issue.id, "me", "Design note recorded before start.");

  const result = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent\nDo the run.",
      auto: true,
    },
    "11111111-1111-4111-8111-111111111111",
  );

  expect(result.run).toMatchObject({
    workflow_id: workflow.id,
    status: "running",
    current_step: "execute",
    rework_count: 0,
    parent_session_id: "11111111-1111-4111-8111-111111111111",
  });
  expect(result.pr.number).toBeGreaterThan(issue.number);
  expect(existsSync(result.worktree)).toBe(true);
  expect(existsSync(result.lock_path)).toBe(true);
  expect(S.getPull(S.getIssue(repo.id, result.pr.number)!.id)).toMatchObject({
    head_sha: gitAt(result.worktree, ["rev-parse", "HEAD"]),
    head_pending_creation: 0,
  });
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
    `lh workflow launch-step --repo '${repo.full_name}' --run ${result.run.id} --step execute`,
  );
  // Transitions are driven only by step status — the run context must say so.
  expect(result.parent.user_prompt).toContain(
    `lh workflow step status ${result.run.id} --repo '${repo.full_name}' --json`,
  );
  expect(result.parent.user_prompt).not.toContain(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(result.parent.user_prompt).not.toMatch(/^\/lh-/m);

  const row = S.getWorkflowRun(result.run.id);
  expect(row).toMatchObject({
    status: "running",
    current_step: "execute",
    rework_count: 0,
    auto_mode: 1,
  });
  // The run-start Execute input carries issue comments too, matching the language
  // instruction's claim that title, body, and comments are in the inputs (#1205).
  expect(
    readFileSync(
      join(
        realpathSync(HOME),
        "runs",
        "workflow",
        String(result.run.id),
        "execute",
        "input",
        "task.md",
      ),
      "utf8",
    ),
  ).toContain("Design note recorded before start.");
  expect(
    S.primaryDevSessionForPull(S.getIssue(repo.id, result.pr.number)!.id),
  ).toBe("11111111-1111-4111-8111-111111111111");

  // Escalation uses an explicit human-wait intent; launch-step refuses to progress during the hold,
  // and an explicit resume intent releases the same run with a fresh rework budget.
  const held = svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: result.run.id, reason: "rework limit exceeded" },
    result.session_id,
  );
  expect(held.run).toMatchObject({
    status: "running",
    needs_human_reason: "rework limit exceeded",
  });
  await expect(
    svc.workflowRuns.launchStep(
      repo.full_name,
      { run: result.run.id, step: "execute", contract: "# Execute" },
      result.session_id,
    ),
  ).rejects.toMatchObject({ status: 409 });
  const resumed = await svc.workflowRuns.resumeAfterHuman(
    repo.full_name,
    { run: result.run.id, step: "execute" },
    result.session_id,
  );
  expect(resumed.run).toMatchObject({
    status: "running",
    needs_human_reason: null,
    rework_count: 0,
  });

  S.createComment(issue.id, "reviewer", "Use the latest design note.");

  const launched = await svc.workflowRuns.launchStep(
    repo.full_name,
    {
      run: result.run.id,
      step: "execute",
      contract: "# Execute contract\n{{step}} {{worktreePath}} {{baseBranch}}",
      model: "sonnet",
    },
    result.session_id,
  );

  expect(launched.step).toBe("execute");
  expect(launched.worktree).toBe(result.worktree);
  expect(existsSync(launched.system_prompt_path)).toBe(true);
  expect(readFileSync(launched.system_prompt_path, "utf8")).toContain(
    "step: execute",
  );
  expect(readFileSync(launched.system_prompt_path, "utf8")).toContain(
    "# Execute contract",
  );
  expect(launched.user_prompt).toContain("Plan and implement a small change.");
  expect(launched.input_files).toEqual([
    expect.objectContaining({
      path: join(
        realpathSync(HOME),
        "runs",
        "workflow",
        String(result.run.id),
        "execute",
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
  expect(launched.herdr.command).toContain("LOOPHUB_WORKFLOW_RUN=");
  expect(launched.herdr.command).toContain("LOOPHUB_WORKFLOW_STEP='execute'");
  expect(launched.herdr.command).toContain("--permission-mode 'auto'");
  expect(launched.agent_name).toBe(`executor #${result.run.id}-1`);

  expect(
    JSON.parse(S.getWorkflowRun(result.run.id)!.step_sessions_json),
  ).toEqual({});
  const unconfirmedLaunch = await svc.workflowRuns.launchStep(
    repo.full_name,
    {
      run: result.run.id,
      step: "execute",
      contract: "# Execute retry",
    },
    result.session_id,
  );
  expect(unconfirmedLaunch.agent_name).toBe(`executor #${result.run.id}-2`);
  expect(
    JSON.parse(S.getWorkflowRun(result.run.id)!.step_sessions_json),
  ).toEqual({});
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: result.run.id,
      step: launched.step,
      sessionId: launched.session_id,
      agentName: launched.agent_name,
      inputFiles: launched.input_files,
    },
    result.session_id,
  );
  const runAfterLaunch = S.getWorkflowRun(result.run.id)!;
  expect(JSON.parse(runAfterLaunch.step_sessions_json)).toEqual({
    execute: [launched.session_id],
  });
  expect(S.getAgentSession(launched.session_id)?.name).toBe(
    launched.agent_name,
  );
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
      phase: "execute",
      direction: "down",
      body: expect.stringContaining("Launch Workflow execute step"),
    }),
  ]);
  const headSha = gitAt(result.worktree, ["rev-parse", "HEAD"]);
  for (const [step, artifact] of [
    [
      "execute",
      {
        type: "execution-report",
        summary: "Implemented launch-step.",
        acceptance: [{ criterion: "launch-step", met: true, note: "Done" }],
        tests: [{ command: "npm test", passed: true, excerpt: "passed" }],
        evidence: [{ kind: "test", description: "focused tests" }],
        reflection: {
          went_well: ["The existing service layer was reusable."],
          friction: [],
          suggestions: [],
          followups: [],
        },
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
    S.createWorkflowArtifact({
      runId: result.run.id,
      step,
      type: artifact.type,
      contentJson,
      headSha,
      submittedBy: result.session_id,
      dedupeKey: `${result.run.id}-${step}`,
    });
  }

  const executeLaunch = await svc.workflowRuns.launchStep(
    repo.full_name,
    {
      run: result.run.id,
      step: "execute",
      contract: "# Execute",
    },
    result.session_id,
  );
  expect(executeLaunch.input_files.map((file) => file.path)).toEqual(
    expect.arrayContaining([expect.stringContaining("/execute/input/task.md")]),
  );
  expect(readFileSync(executeLaunch.system_prompt_path, "utf8")).toContain(
    "# Execute",
  );
  expect(executeLaunch.herdr.command).toContain("--permission-mode 'auto'");
  expect(executeLaunch.agent_name).toBe(`executor #${result.run.id}-3`);
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: result.run.id,
      step: executeLaunch.step,
      sessionId: executeLaunch.session_id,
      inputFiles: executeLaunch.input_files,
    },
    result.session_id,
  );

  const verifyLaunch = await svc.workflowRuns.launchStep(
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
  expect(verifyLaunch.herdr.command).toContain("--permission-mode 'auto'");
  expect(verifyLaunch.agent_name).toBe(`verifier #${result.run.id}-4`);
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: result.run.id,
      step: verifyLaunch.step,
      sessionId: verifyLaunch.session_id,
      inputFiles: verifyLaunch.input_files,
      headSha: verifyLaunch.head_sha,
    },
    result.session_id,
  );

  const reworkExecuteLaunch = await svc.workflowRuns.launchStep(
    repo.full_name,
    {
      run: result.run.id,
      step: "execute",
      contract: "# Execute rework",
    },
    result.session_id,
  );
  expect(reworkExecuteLaunch.herdr.command).toContain(
    "--permission-mode 'auto'",
  );
  expect(reworkExecuteLaunch.agent_name).toBe(`executor #${result.run.id}-5`);
});

test("start persists the resolved runtime/model and every step inherits them (#516)", async () => {
  const repo = S.getRepo("me", "workflow-run")!;
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Codex run",
    "## Acceptance criteria\n- [ ] It works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "codex-standard",
    description: "",
    executePrompt: "Plan and implement it.",
    verifyPrompt: "",
  });

  const result = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent\nDo the run.",
      runtime: "codex",
      model: "gpt-5.5",
    },
    "33333333-3333-4333-8333-333333333333",
  );

  // The resolved runtime + model are persisted on the run row so steps read them back.
  const row = S.getWorkflowRun(result.run.id)!;
  expect(row.runtime).toBe("codex");
  expect(row.model).toBe("gpt-5.5");
  // The parent session records the runtime it actually launched in (#516).
  expect(S.getAgentSession(result.session_id)?.runtime).toBe("codex");

  const launched = await svc.workflowRuns.launchStep(
    repo.full_name,
    {
      run: result.run.id,
      step: "execute",
      contract: "# Execute\n{{step}}",
    },
    result.session_id,
  );
  // The step inherits the parent runtime/model: it launches codex (no claude, no --session-id) with
  // the saved model, without the caller re-specifying anything.
  expect(launched.runtime).toBe("codex");
  expect(launched.herdr.command).toContain("codex ");
  expect(launched.herdr.command).not.toContain("claude");
  expect(launched.herdr.command).not.toContain("--session-id");
  expect(launched.herdr.command).toContain("--model 'gpt-5.5'");

  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: result.run.id,
      step: launched.step,
      sessionId: launched.session_id,
      inputFiles: launched.input_files,
    },
    result.session_id,
  );
  // The launched step session is recorded with the inherited runtime, not a hardcoded claude-code.
  expect(S.getAgentSession(launched.session_id)?.runtime).toBe("codex");
});

test("start defaults to claude-code and the config default model when unspecified (#516)", async () => {
  const repo = S.getRepo("me", "workflow-run")!;
  const issue = S.createIssue(repo.id, "issue", "Default run", "Body", "me");
  const workflow = S.createWorkflow({
    name: "default-standard",
    description: "",
    executePrompt: "Plan and implement it.",
    verifyPrompt: "",
  });

  const result = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent",
    },
    "44444444-4444-4444-8444-444444444444",
  );

  const row = S.getWorkflowRun(result.run.id)!;
  expect(row.runtime).toBe("claude-code");
  expect(row.model).toBeNull();
  expect(S.getAgentSession(result.session_id)?.runtime).toBe("claude-code");

  // A step launched from this run falls back to claude-code + the agent's config default model.
  const launched = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: result.run.id, step: "execute", contract: "# Execute" },
    result.session_id,
  );
  expect(launched.runtime).toBe("claude-code");
  expect(launched.herdr.command).toContain("claude --session-id");
  expect(launched.herdr.command).toContain("--model 'opus'");
});

test("step output validates, stamps, places, readies, and retries an accepted artifact", async () => {
  const repo = S.getRepo("me", "workflow-run")!;
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Place Workflow output",
    "## Acceptance criteria\n- [ ] It is placed\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "output-test",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const started = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent",
    },
    "22222222-2222-4222-8222-222222222222",
  );

  await expect(
    svc.workflowRuns.stepOutput(
      repo.full_name,
      { run: started.run.id, step: "execute", content: "{" },
      started.session_id,
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(S.latestWorkflowArtifact(started.run.id, "execute")).toBeNull();
  await expect(
    svc.workflowRuns.stepOutput(
      repo.full_name,
      {
        run: started.run.id,
        step: "execute",
        content: JSON.stringify({
          type: "verdict",
          event: "pass",
          summary: "Wrong step.",
          findings: [],
        }),
      },
      started.session_id,
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(S.latestWorkflowArtifact(started.run.id, "execute")).toBeNull();

  const outsideArtifacts = join(HOME, "outside-artifacts");
  mkdirSync(outsideArtifacts);
  const artifactDirectory = join(
    HOME,
    "runs",
    "workflow",
    String(started.run.id),
    "artifacts",
  );
  symlinkSync(outsideArtifacts, artifactDirectory);
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
    reflection: {
      went_well: ["Placement remained centralized."],
      friction: [],
      suggestions: [],
      followups: [],
    },
  });
  expect(existsSync(join(outsideArtifacts, "latest", "execute.json"))).toBe(
    false,
  );
  rmSync(artifactDirectory);
  await expect(
    svc.workflowRuns.stepOutput(
      repo.full_name,
      { run: started.run.id, step: "execute", content: report },
      started.session_id,
    ),
  ).rejects.toThrow();
  const accepted = S.latestWorkflowArtifact(started.run.id, "execute")!;
  expect(S.getWorkflowPlacement(accepted.id)).toBeNull();
  const firstClaim = S.claimWorkflowPlacement(accepted.id);
  expect(firstClaim).toEqual(expect.any(String));
  expect(S.claimWorkflowPlacement(accepted.id)).toBeNull();
  D.db.run(
    `UPDATE workflow_placement_claims SET claimed_at = ? WHERE artifact_id = ?`,
    ["2000-01-01T00:00:00.000Z", accepted.id],
  );
  const replacementClaim = S.claimWorkflowPlacement(accepted.id);
  expect(replacementClaim).toEqual(expect.any(String));
  expect(S.renewWorkflowPlacementClaim(accepted.id, replacementClaim!)).toBe(
    true,
  );
  S.releaseWorkflowPlacementClaim(accepted.id, firstClaim!);
  expect(S.claimWorkflowPlacement(accepted.id)).toBeNull();
  S.releaseWorkflowPlacementClaim(accepted.id, replacementClaim!);

  writeFileSync(join(started.worktree, missingScreenshot), "png bytes");
  writeFileSync(
    join(started.worktree, "README.md"),
    "head changed before retry\n",
  );
  gitAt(started.worktree, ["add", "README.md"]);
  gitAt(started.worktree, ["commit", "-m", "Advance before retry"]);
  const retried = await svc.workflowRuns.stepOutput(
    repo.full_name,
    { run: started.run.id, step: "execute", content: report },
    started.session_id,
  );
  expect(retried).toMatchObject({ artifact_id: accepted.id, retried: true });
  expect(retried.head_sha).toBe(accepted.head_sha);
  const pull = await svc.pulls.get(repo.full_name, started.pr.number);
  expect(pull.draft).toBe(false);
  expect(pull.body).toContain("![later.png](/attachments/");
  expect(S.getWorkflowPlacement(accepted.id)?.target_kind).toBe(
    "pr-body-report",
  );
  const duplicate = await svc.workflowRuns.stepOutput(
    repo.full_name,
    { run: started.run.id, step: "execute", content: report },
    started.session_id,
  );
  expect(duplicate.artifact_id).not.toBe(accepted.id);
  expect(duplicate.retried).toBe(false);

  const verifyLaunch = await svc.workflowRuns.launchStep(
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
  const secondVerifyLaunch = await svc.workflowRuns.launchStep(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      contract: "# Verify again",
      model: "sonnet",
    },
    started.session_id,
  );
  const confirmed = svc.workflowRuns.confirmStepLaunch(
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
  svc.workflowRuns.confirmStepLaunch(
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
  const verdict = await svc.workflowRuns.stepOutput(
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
  D.db.run(`UPDATE workflow_step_pins SET head_sha = ? WHERE session_id = ?`, [
    "not-a-sha",
    secondVerifyLaunch.session_id,
  ]);
  await expect(
    svc.workflowRuns.stepOutput(
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

  D.db.run(`UPDATE workflow_step_pins SET head_sha = ? WHERE session_id = ?`, [
    secondVerifyLaunch.head_sha,
    secondVerifyLaunch.session_id,
  ]);
  const crossSessionContent = JSON.stringify({
    type: "verdict",
    event: "pass",
    summary: "Same JSON from another session.",
    findings: [],
  });
  const firstSessionArtifact = S.createWorkflowArtifact({
    runId: started.run.id,
    step: "verify",
    type: "verdict",
    contentJson: crossSessionContent,
    headSha: pinnedHead,
    submittedBy: confirmed.session_id,
    dedupeKey: "cross-session-a",
  });
  const secondSessionVerdict = await svc.workflowRuns.stepOutput(
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

  svc.workflowRuns.stopRun(
    repo.full_name,
    { run: started.run.id },
    started.session_id,
  );
  await expect(
    svc.workflowRuns.stepOutput(
      repo.full_name,
      { run: started.run.id, step: "execute", content: "{}" },
      started.session_id,
    ),
  ).rejects.toMatchObject({ status: 422 });
  expect(S.latestWorkflowArtifact(started.run.id, "execute")).not.toBeNull();
}, 15_000);

test("agentless e2e: step output drives both steps to complete, then head advance makes them stale", async () => {
  const repo = S.getRepo("me", "workflow-run")!;
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Agentless run",
    "## Acceptance criteria\n- [ ] It completes\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "agentless",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const session = "33333333-3333-4333-8333-333333333333";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent",
    },
    session,
  );
  expect(S.getWorkflowRun(started.run.id)?.auto_mode).toBe(0);

  // Nothing placed yet: both steps are incomplete.
  const initial = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(initial.steps.execute.missing).toEqual([
    "no validated execution-report for current head",
    "head equals base",
  ]);
  expect(initial.steps.verify.latest_verdict).toBeNull();

  // step input is a dry-run window: same composition, no session/handoff created.
  const handoffsBefore = S.listHandoffs(repo.id, {
    prId: S.getIssue(repo.id, started.pr.number)!.id,
  }).length;
  const dryRun = await svc.workflowRuns.stepInput(repo.full_name, {
    run: started.run.id,
    step: "execute",
    contract: "# Execute contract\n{{step}} {{worktreePath}} {{baseBranch}}",
  });
  expect(dryRun.system_prompt).toContain("# Execute contract");
  expect(dryRun.user_prompt).toContain("## Inputs");
  expect(dryRun.input_files.map((f) => f.path)).toEqual([
    expect.stringContaining("/execute/input/task.md"),
  ]);
  expect(
    JSON.parse(S.getWorkflowRun(started.run.id)!.step_sessions_json),
  ).toEqual({});
  expect(
    S.listHandoffs(repo.id, {
      prId: S.getIssue(repo.id, started.pr.number)!.id,
    }).length,
  ).toBe(handoffsBefore);

  // Execute plans the change itself and needs a commit so the head is ahead of base.
  writeFileSync(join(started.worktree, "impl.txt"), "work\n");
  gitAt(started.worktree, ["add", "impl.txt"]);
  gitAt(started.worktree, ["commit", "-m", "Implement"]);
  const executeHead = gitAt(started.worktree, ["rev-parse", "HEAD"]);
  await svc.workflowRuns.stepOutput(
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
        reflection: {
          went_well: ["Composition works"],
          friction: [],
          suggestions: [],
          followups: [],
        },
      }),
    },
    session,
  );
  const afterExecute = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(afterExecute.steps.execute).toEqual({ complete: true, missing: [] });

  // Verify (submitted by the parent session, stamped at current head).
  await svc.workflowRuns.stepOutput(
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
  const afterVerify = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(afterVerify.steps.verify.complete).toBe(true);
  expect(afterVerify.steps.verify.latest_verdict).toEqual({
    event: "pass",
    summary: "AC satisfied.",
    findings: [],
  });

  const allComplete = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(Object.values(allComplete.steps).every((s) => s.complete)).toBe(true);

  // Advancing the head makes execution-report and verdict stale (both were
  // stamped at executeHead, not the new head).
  writeFileSync(join(started.worktree, "impl.txt"), "more work\n");
  gitAt(started.worktree, ["add", "impl.txt"]);
  gitAt(started.worktree, ["commit", "-m", "Advance head"]);
  expect(gitAt(started.worktree, ["rev-parse", "HEAD"])).not.toBe(executeHead);
  const stale = await svc.workflowRuns.status(repo.full_name, {
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
  // The latest verdict summary survives staleness for the parent's rework read.
  expect(stale.steps.verify.latest_verdict?.event).toBe("pass");
}, 20_000);

test("intent-based run lifecycle rejects invalid transitions and owns rework counts", async () => {
  const repo = S.getRepo("me", "workflow-run")!;
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Lifecycle intents",
    "## Acceptance criteria\n- [ ] Transitions are guarded\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "lifecycle-intents",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "77777777-7777-4777-8777-777777777777";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent",
    },
    parent,
  );
  const lifecycleEvents = () =>
    S.eventsForWorkflowRun(repo.id, started.run.id)
      .filter((event) => event.type === "workflow_run.updated")
      .map((event) => JSON.parse(event.payload) as Record<string, unknown>);

  expect("update" in svc.workflowRuns).toBe(false);
  await expect(
    svc.workflowRuns.completeRun(
      repo.full_name,
      { run: started.run.id },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    svc.workflowRuns.advanceToVerify(
      repo.full_name,
      { run: started.run.id },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });

  writeFileSync(join(started.worktree, "lifecycle.txt"), "implemented\n");
  gitAt(started.worktree, ["add", "lifecycle.txt"]);
  gitAt(started.worktree, ["commit", "-m", "Implement lifecycle fixture"]);
  const headSha = gitAt(started.worktree, ["rev-parse", "HEAD"]);
  const place = (
    step: "execute" | "verify",
    artifact:
      | {
          type: "execution-report";
          summary: string;
          acceptance: Array<{ criterion: string; met: boolean; note: string }>;
          tests: Array<{ command: string; passed: boolean; excerpt: string }>;
          evidence: Array<{ kind: "test"; description: string }>;
          reflection: {
            went_well: string[];
            friction: never[];
            suggestions: never[];
            followups: never[];
          };
        }
      | {
          type: "verdict";
          event: "pass" | "request_changes";
          summary: string;
          findings: Array<{
            file: string;
            problem: string;
            expected: string;
          }>;
        },
  ) => {
    const row = S.createWorkflowArtifact({
      runId: started.run.id,
      step,
      type: artifact.type,
      contentJson: JSON.stringify(artifact),
      headSha,
      submittedBy: parent,
      dedupeKey: `${started.run.id}-${step}-${artifact.type}-${artifact.type === "verdict" ? artifact.event : "report"}`,
    });
    S.createWorkflowPlacement(row.id, "test", String(row.id));
  };
  place("execute", {
    type: "execution-report",
    summary: "Implemented.",
    acceptance: [
      { criterion: "Transitions are guarded", met: true, note: "Done." },
    ],
    tests: [{ command: "npm test", passed: true, excerpt: "passed" }],
    evidence: [{ kind: "test", description: "lifecycle test" }],
    reflection: {
      went_well: ["Intent interface is explicit."],
      friction: [],
      suggestions: [],
      followups: [],
    },
  });

  const verifying = await svc.workflowRuns.advanceToVerify(
    repo.full_name,
    { run: started.run.id },
    parent,
  );
  expect(verifying.run.current_step).toBe("verify");
  await expect(
    svc.workflowRuns.completeRun(
      repo.full_name,
      { run: started.run.id },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });

  const held = svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: started.run.id, reason: "needs guidance\nnow" },
    parent,
  );
  expect(held.run.needs_human_reason).toBe("needs guidance now");
  expect(() =>
    svc.workflowRuns.awaitHuman(
      repo.full_name,
      { run: started.run.id, reason: "again" },
      parent,
    ),
  ).toThrowError(/already waiting/);
  const resumed = await svc.workflowRuns.resumeAfterHuman(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  expect(resumed.run).toMatchObject({
    status: "running",
    current_step: "verify",
    needs_human_reason: null,
    rework_count: 0,
  });

  place("verify", {
    type: "verdict",
    event: "request_changes",
    summary: "One change is required.",
    findings: [
      { file: "lifecycle.txt", problem: "fixture", expected: "updated" },
    ],
  });
  S.updateWorkflowRun(started.run.id, { reworkCount: 2 });
  const rework = await svc.workflowRuns.requestRework(
    repo.full_name,
    { run: started.run.id },
    parent,
  );
  expect(rework.run).toMatchObject({
    current_step: "execute",
    rework_count: 3,
  });
  await expect(
    svc.workflowRuns.requestRework(
      repo.full_name,
      { run: started.run.id },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(S.getWorkflowRun(started.run.id)?.rework_count).toBe(3);

  await svc.workflowRuns.advanceToVerify(
    repo.full_name,
    { run: started.run.id },
    parent,
  );
  await expect(
    svc.workflowRuns.requestRework(
      repo.full_name,
      { run: started.run.id },
      parent,
    ),
  ).rejects.toThrowError(/rework limit/);
  expect(S.getWorkflowRun(started.run.id)?.rework_count).toBe(3);
  place("verify", {
    type: "verdict",
    event: "pass",
    summary: "All criteria pass.",
    findings: [],
  });
  const completed = await svc.workflowRuns.completeRun(
    repo.full_name,
    { run: started.run.id },
    parent,
  );
  expect(completed.run.status).toBe("completed");
  await expect(
    svc.workflowRuns.resumeAfterHuman(
      repo.full_name,
      { run: started.run.id, step: "execute" },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(() =>
    svc.workflowRuns.stopRun(repo.full_name, { run: started.run.id }, parent),
  ).toThrowError(/completed/);

  expect(lifecycleEvents().map((event) => event.transition)).toEqual([
    "advance_to_verify",
    "await_human",
    "resume_after_human",
    "request_rework",
    "advance_to_verify",
    "complete",
  ]);
  expect(
    svc.workflowRuns
      .history(repo.full_name, { run: started.run.id })
      .filter((event) => event.type === "workflow_run.updated")
      .map((event) => event.label),
  ).toEqual([
    "Run advanced to Verify",
    "Run needs human",
    "Run resumed",
    "Run rework requested",
    "Run advanced to Verify",
    "Run completed",
  ]);

  const stoppedRun = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: started.issue.number,
    prNumber: started.pr.number,
    status: "running",
    currentStep: "execute",
    parentSessionId: parent,
  });
  expect(
    svc.workflowRuns.stopRun(repo.full_name, { run: stoppedRun.id }, parent).run
      .status,
  ).toBe("stopped");
  await expect(
    svc.workflowRuns.resumeAfterHuman(
      repo.full_name,
      { run: stoppedRun.id, step: "execute" },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });
}, 20_000);

test("parent contract template specifies transitions, rework, and escalation", () => {
  const contract = readFileSync(
    join(import.meta.dirname, "workflow", "contracts", "parent.md"),
    "utf8",
  );
  // AC: allowed LoopHub / herdr commands are listed.
  expect(contract).toContain("lh workflow run complete");
  expect(contract).toContain("lh workflow run request-rework");
  expect(contract).toContain("lh workflow launch-step");
  expect(contract).toContain("lh workflow step status");
  expect(contract).toContain("herdr pane run");
  // AC: transitions are driven only by step status, not pane output / PR markers.
  expect(contract).toContain(
    "Transitions are driven only by `lh workflow step status`",
  );
  expect(contract).toMatch(/never use pane output|PR body marker/i);
  // AC: the simplified step transition table.
  expect(contract).toContain("launch Execute");
  expect(contract).toContain("execute complete");
  expect(contract).toContain("verdict `pass`");
  expect(contract).toContain("verdict `request_changes`");
  expect(contract).toContain("run complete");
  expect(contract).toContain("planning and reflection");
  // AC: rework increments the count, caps at 3, and restarts Execute; Verify is always fresh.
  expect(contract).toContain("run request-rework");
  expect(contract).toContain("would exceed 3");
  expect(contract).toContain("--step execute");
  expect(contract).toContain("Verify as a fresh child");
  // AC: escalation via issue comment + inbox + a resumable human hold (#1307) — never the retired
  // terminal 'blocked' status.
  expect(contract).toContain("lh issue comment");
  expect(contract).toContain("lh inbox send");
  expect(contract).toContain("run await-human");
  expect(contract).not.toContain("--status blocked");
  // AC: resume only on an explicit human instruction, clearing the hold and rework budget.
  expect(contract).toContain("run resume");
  expect(contract).toContain("Never resume on your own");
  // AC: skill independence — the contract forbids slash commands.
  expect(contract).toContain("Do not call slash commands");
});

test("stateForIssue / stateForPull expose run display state, or null when absent (#1008)", async () => {
  const repo = S.createRepo("me/workflow-state", REPO_PATH);
  const issue = S.createIssue(repo.id, "issue", "Show run state", "body", "me");
  const workflow = S.createWorkflow({
    name: "state-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });

  // No run yet -> both lookups return null.
  expect(
    await svc.workflowRuns.stateForIssue(repo.full_name, {
      issue: issue.number,
    }),
  ).toBeNull();
  expect(
    await svc.workflowRuns.stateForPull(repo.full_name, { pull: 4242 }),
  ).toBeNull();

  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: 4242,
    status: "running",
    currentStep: "verify",
    parentSessionId: "22222222-2222-4222-8222-222222222222",
  });
  S.updateWorkflowRun(run.id, { reworkCount: 2 });

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
  S.createWorkflowArtifact({
    runId: run.id,
    step: "verify",
    type: "verdict",
    contentJson: JSON.stringify(verdict),
    headSha: "0".repeat(40),
    submittedBy: "22222222-2222-4222-8222-222222222222",
    dedupeKey: "state-wf-verdict-1",
  });

  const byIssue = await svc.workflowRuns.stateForIssue(repo.full_name, {
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

  const byPull = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: 4242,
  });
  expect(byPull?.id).toBe(run.id);
  expect(byPull?.workflow_name).toBe("state-wf");
  expect(byPull?.needs_human_reason).toBeNull();

  // The human-wait reason is part of the display state (#1307).
  S.updateWorkflowRun(run.id, { needsHumanReason: "waiting for guidance" });
  const waiting = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: 4242,
  });
  expect(waiting?.needs_human_reason).toBe("waiting for guidance");
});

test("human lifecycle intents sanitize reasons and authorize explicit resume or stop (#1307)", async () => {
  const repo = S.createRepo("me/workflow-hold", REPO_PATH);
  const workflow = S.createWorkflow({
    name: "hold-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "44444444-4444-4444-8444-444444444444";
  S.registerAgentSession(parent, "lh-workflow", parent);
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 11,
    prNumber: 22,
    status: "running",
    currentStep: "execute",
    parentSessionId: parent,
  });
  // The emitted payload carries needs_human_reason when an intent enters or leaves the hold.
  const latestUpdatedPayload = () => {
    const events = S.eventsForWorkflowRun(repo.id, run.id).filter(
      (event) => event.type === "workflow_run.updated",
    );
    return JSON.parse(events.at(-1)!.payload) as Record<string, unknown>;
  };

  // The reason is sanitized at the write point (control chars stripped, whitespace collapsed) and
  // capped so it stays safe in error messages, event payloads, and history text.
  expect(() =>
    svc.workflowRuns.awaitHuman(
      repo.full_name,
      { run: run.id, reason: "x".repeat(501) },
      parent,
    ),
  ).toThrowError(/500/);
  S.updateWorkflowRun(run.id, { reworkCount: 3 });
  const held = svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run.id, reason: "rework limit\nexceeded" },
    parent,
  );
  expect(held.run.needs_human_reason).toBe("rework limit exceeded");
  expect(latestUpdatedPayload().needs_human_reason).toBe(
    "rework limit exceeded",
  );

  // A stranger session may not mutate the run; a human (me) CLI session may — the recovery path
  // for a hold whose parent session died.
  const stranger = "55555555-5555-4555-8555-555555555555";
  S.registerAgentSession(stranger, "workflow-step", stranger);
  expect(() =>
    svc.workflowRuns.stopRun(repo.full_name, { run: run.id }, stranger),
  ).toThrowError(/parent session/);
  const human = "66666666-6666-4666-8666-666666666666";
  S.registerAgentSession(human, "me", "cli");

  // Explicit resume restores the rework budget and records the selected resume step.
  const resumed = await svc.workflowRuns.resumeAfterHuman(
    repo.full_name,
    { run: run.id, step: "execute" },
    human,
  );
  expect(resumed.run).toMatchObject({
    needs_human_reason: null,
    rework_count: 0,
  });
  // The resume payload carries the explicit null so history labels it "Run resumed".
  expect(latestUpdatedPayload().needs_human_reason).toBeNull();
  expect("needs_human_reason" in latestUpdatedPayload()).toBe(true);
  await expect(
    svc.workflowRuns.resumeAfterHuman(
      repo.full_name,
      { run: run.id, step: "execute" },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });

  // A human cancel of a held run ends terminal and no longer waiting; the terminal payload omits
  // the needs_human key so history reads "Run stopped", not a resume.
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run.id, reason: "waiting for guidance" },
    parent,
  );
  const cancelled = svc.workflowRuns.stopRun(
    repo.full_name,
    { run: run.id },
    human,
  );
  expect(cancelled.run).toMatchObject({
    status: "stopped",
    needs_human_reason: null,
  });
  expect(latestUpdatedPayload().status).toBe("stopped");
  expect("needs_human_reason" in latestUpdatedPayload()).toBe(false);

  // Stopping a held run keeps its historical rework count; only resume resets the budget.
  const run2 = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 12,
    prNumber: 23,
    status: "running",
    currentStep: "execute",
    parentSessionId: parent,
  });
  S.updateWorkflowRun(run2.id, { reworkCount: 3 });
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run2.id, reason: "stuck" },
    parent,
  );
  const comboCancelled = svc.workflowRuns.stopRun(
    repo.full_name,
    { run: run2.id },
    human,
  );
  expect(comboCancelled.run).toMatchObject({
    status: "stopped",
    needs_human_reason: null,
    rework_count: 3,
  });
});

test("history returns readable lifecycle events scoped to one Workflow run (#1290)", () => {
  const repo = S.createRepo("me/workflow-history", REPO_PATH);
  const workflow = S.createWorkflow({
    name: "history-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 10,
    prNumber: 20,
    status: "running",
    currentStep: "execute",
    parentSessionId: "33333333-3333-4333-8333-333333333333",
  });
  const otherRun = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 10,
    prNumber: 20,
    status: "running",
    currentStep: "plan",
    parentSessionId: "44444444-4444-4444-8444-444444444444",
  });

  S.emitEvent(repo.id, "workflow_run.started", "parent", {
    id: run.id,
    issue_number: 10,
    pr_number: 20,
  });
  S.emitEvent(repo.id, "workflow_run.updated", "parent", {
    id: run.id,
    status: "running",
    current_step: "execute",
    rework_count: 1,
    issue_number: 10,
    pr_number: 20,
  });
  S.emitEvent(repo.id, "workflow_step.launched", "execute-agent", {
    id: run.id,
    step: "execute",
    issue_number: 10,
    pr_number: 20,
  });
  S.emitEvent(repo.id, "workflow_artifact.placed", "execute-agent", {
    id: run.id,
    step: "execute",
    type: "execution-report",
    target_kind: "pr-body",
    target_ref: "Evidence",
    issue_number: 10,
    pr_number: 20,
  });
  // Escalation and human-instructed resume (#1307): the payload carries needs_human_reason only
  // when the update touched the hold — a string marks the escalation, null the resume.
  S.emitEvent(repo.id, "workflow_run.updated", "parent", {
    id: run.id,
    status: "running",
    current_step: "execute",
    rework_count: 3,
    needs_human_reason: "rework limit exceeded",
    issue_number: 10,
    pr_number: 20,
  });
  S.emitEvent(repo.id, "workflow_run.updated", "parent", {
    id: run.id,
    status: "running",
    current_step: "execute",
    rework_count: 0,
    needs_human_reason: null,
    issue_number: 10,
    pr_number: 20,
  });
  // Same PR and lifecycle namespace, but a different run id: must not leak into the result.
  S.emitEvent(repo.id, "workflow_step.launched", "other-agent", {
    id: otherRun.id,
    step: "plan",
    issue_number: 10,
    pr_number: 20,
  });
  S.emitEvent(repo.id, "pull_request.updated", "parent", {
    id: run.id,
    number: 20,
  });
  for (let index = 0; index < 1001; index++) {
    S.emitEvent(repo.id, "workflow_run.updated", "parent", {
      id: run.id,
      status: index === 1000 ? "completed" : "running",
      current_step: "reflect",
      rework_count: 1,
      issue_number: 10,
      pr_number: 20,
    });
  }

  const history = svc.workflowRuns.history(repo.full_name, { run: run.id });
  expect(history.slice(0, 4).map((event) => event.type)).toEqual([
    "workflow_run.started",
    "workflow_run.updated",
    "workflow_step.launched",
    "workflow_artifact.placed",
  ]);
  expect(history.slice(0, 4).map((event) => event.label)).toEqual([
    "Run started",
    "Run state updated",
    "Execute step started",
    "Execution report artifact placed",
  ]);
  expect(history[1]).toMatchObject({
    step: "execute",
    actor: "parent",
    description: "Status: Running. Current step: Execute. Rework count: 1.",
  });
  expect(history[3].description).toContain("Placement: pr-body (Evidence)");
  // Escalation and human-instructed resume are visible in the run history (#1307).
  expect(history[4]).toMatchObject({ label: "Run needs human" });
  expect(history[4].description).toContain(
    "Waiting for a human: rework limit exceeded",
  );
  expect(history[5]).toMatchObject({ label: "Run resumed" });
  expect(history[5].description).toContain("Rework count: 0.");
  // A complete history includes the newest event even after the old 1,000-event boundary.
  expect(history).toHaveLength(1007);
  expect(history.at(-1)?.label).toBe("Run completed");
});
