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

const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-runs-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-runs-repo-"));
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

function gitAt(path: string, args: string[]): string {
  const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
  if ((result.status ?? 0) !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

// A run that provisions a real worktree creates a `loophub/pr-<m>` branch in its git repo. Tests
// that start such a run need their own git checkout so those branch names never collide across
// tests (they all share PR numbering per loophub repo).
function freshRepo(loophubName: string): {
  repo: ReturnType<typeof S.createRepo>;
  path: string;
} {
  const path = mkdtempSync(join(tmpdir(), "lh-workflow-runs-repo-"));
  spawnSync("git", ["-C", path, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", path, "config", "user.email", "t@example.local"]);
  spawnSync("git", ["-C", path, "config", "user.name", "tester"]);
  writeFileSync(join(path, "README.md"), "hello\n");
  spawnSync("git", ["-C", path, "add", "-A"]);
  spawnSync("git", ["-C", path, "commit", "-qm", "init"]);
  return { repo: S.createRepo(loophubName, path), path };
}

// Advance the worktree HEAD by one commit and return the new head SHA. Advancing HEAD is what makes
// the engine observe "execute has new work to verify" — there is no artifact to submit.
function commit(worktree: string, name: string, content: string): string {
  writeFileSync(join(worktree, name), content);
  gitAt(worktree, ["add", name]);
  gitAt(worktree, ["commit", "-q", "-m", `add ${name}`]);
  return gitAt(worktree, ["rev-parse", "HEAD"]);
}

// Create the domain fact a Verify child would produce: a PR review authored by the run's verifier
// child, topic `workflow`, pinned to the reviewed head SHA. The engine reads the run's verdict from
// this review, not from any artifact.
function createWorkflowReview(input: {
  prIssueId: number;
  runId: number;
  sequence: number;
  event: "PASS" | "REQUEST_CHANGES";
  headSha: string;
  body: string;
  findings?: number;
}): void {
  const author = `verifier #${input.runId}-${input.sequence}`;
  const review = S.createReview(
    input.prIssueId,
    author,
    input.event,
    input.body,
    input.headSha,
    "workflow",
  );
  for (let i = 0; i < (input.findings ?? 0); i++) {
    S.createReviewComment(input.prIssueId, review.id, author, {
      path: `file-${i}.ts`,
      line: i + 1,
      body: "needs a fix",
    });
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

test("start prepares a run and hands the parent pointers, not synthesized inputs", async () => {
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

  const parentSystemPrompt = readFileSync(
    result.parent.system_prompt_path,
    "utf8",
  );
  expect(parentSystemPrompt).toContain("step: parent");
  expect(parentSystemPrompt).toContain("# Parent");
  // The parent observes; it subscribes to turn-done and drives transitions from step status.
  expect(result.parent.user_prompt).toContain(`run: ${result.run.id}`);
  expect(result.parent.user_prompt).toContain(`issue: #${result.issue.number}`);
  expect(result.parent.user_prompt).toContain(`pr: #${result.pr.number}`);
  expect(result.parent.user_prompt).toContain(
    "lh subscribe --repo '" +
      repo.full_name +
      "' --event workflow_run.turn_done",
  );
  expect(result.parent.user_prompt).toContain(
    `lh workflow launch-step --repo '${repo.full_name}' --run ${result.run.id} --step execute`,
  );
  expect(result.parent.user_prompt).toContain(
    `lh workflow step status ${result.run.id} --repo '${repo.full_name}' --json`,
  );
  // The parent session id is never leaked into the prompt text.
  expect(result.parent.user_prompt).not.toContain(
    "11111111-1111-4111-8111-111111111111",
  );

  // Escalation blocks automatic progress; an explicit resume releases it with a fresh rework budget.
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: result.run.id, reason: "rework limit exceeded" },
    result.session_id,
  );
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

  // launch-step returns pointers (repo/issue/pr), not synthesized input files, and records the
  // launched child session on confirm.
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
  expect(readFileSync(launched.system_prompt_path, "utf8")).toContain(
    "step: execute",
  );
  expect(launched.user_prompt).toContain("Plan and implement a small change.");
  expect(launched.pointers).toEqual([
    { label: "repo", value: repo.full_name },
    { label: "issue", value: `#${result.issue.number}` },
    { label: "pr", value: `#${result.pr.number}` },
  ]);
  expect(launched.herdr.command).toContain("LOOPHUB_WORKFLOW_RUN=");
  expect(launched.herdr.command).toContain("LOOPHUB_WORKFLOW_STEP='execute'");
  expect(launched.herdr.command).toContain("--permission-mode 'auto'");
  expect(launched.agent_name).toBe(`executor #${result.run.id}-1`);

  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: result.run.id,
      step: launched.step,
      sessionId: launched.session_id,
      agentName: launched.agent_name,
      pointers: launched.pointers,
    },
    result.session_id,
  );
  expect(
    JSON.parse(S.getWorkflowRun(result.run.id)!.step_sessions_json),
  ).toEqual({ execute: [launched.session_id] });
  expect(S.getAgentSession(launched.session_id)?.name).toBe(
    launched.agent_name,
  );
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
  expect(
    svc.workflowRuns
      .history(repo.full_name, { run: result.run.id })
      .find((event) => event.type === "workflow_step.launched")?.input,
  ).toContain("## Inputs\n- repo: me/workflow-run");
}, 20_000);

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

  const row = S.getWorkflowRun(result.run.id)!;
  expect(row.runtime).toBe("codex");
  expect(row.model).toBe("gpt-5.5");
  expect(S.getAgentSession(result.session_id)?.runtime).toBe("codex");

  const launched = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: result.run.id, step: "execute", contract: "# Execute\n{{step}}" },
    result.session_id,
  );
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
      pointers: launched.pointers,
    },
    result.session_id,
  );
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

  const launched = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: result.run.id, step: "execute", contract: "# Execute" },
    result.session_id,
  );
  expect(launched.runtime).toBe("claude-code");
  expect(launched.herdr.command).toContain("claude --session-id");
  expect(launched.herdr.command).toContain("--model 'opus'");
});

test("agentless e2e: Execute turn done -> observe HEAD -> Verify pass, then a new commit makes it stale", async () => {
  const { repo } = freshRepo("me/workflow-e2e");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "E2E",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "e2e-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent",
    },
    parent,
  );
  const prIssueId = S.getIssue(repo.id, started.pr.number)!.id;

  // Launch + confirm the Execute child.
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute", contract: "# Execute" },
    parent,
  );
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      sessionId: exec.session_id,
      agentName: exec.agent_name,
      pointers: exec.pointers,
    },
    parent,
  );

  // A turn-done declaration before any commit is only a timing signal: HEAD has not advanced, so
  // Execute is not complete and advance-to-verify is refused.
  const before = svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  expect(before.event_id).toBeGreaterThan(0);
  let status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.last_turn_done_at).not.toBeNull();
  expect(status.head_ahead_of_base).toBe(false);
  expect(status.steps.execute.complete).toBe(false);
  await expect(
    svc.workflowRuns.advanceToVerify(
      repo.full_name,
      { run: started.run.id },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });

  // Execute commits, then declares turn done again. Now HEAD is ahead of base.
  const headA = commit(started.worktree, "impl.txt", "done\n");
  svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.head_ahead_of_base).toBe(true);
  expect(status.steps.execute.complete).toBe(true);

  await svc.workflowRuns.advanceToVerify(
    repo.full_name,
    { run: started.run.id },
    parent,
  );

  // Verify submits a passing review pinned to the reviewed head.
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify", contract: "# Verify" },
    parent,
  );
  expect(verify.head_sha).toBe(headA);
  expect(verify.base_sha).toBe(
    gitAt(started.worktree, ["merge-base", "main", headA]),
  );
  // Verify pointers are the fixed triple plus the review target — never a task/diff file.
  expect(verify.pointers.map((p) => p.label)).toEqual([
    "repo",
    "issue",
    "base sha",
    "head sha",
    "review submission target (do not read the PR)",
  ]);
  createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 1,
    event: "PASS",
    headSha: headA,
    body: "All criteria pass.",
  });

  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.complete).toBe(true);
  expect(status.steps.verify.latest_review).toMatchObject({
    event: "pass",
    fresh: true,
    headSha: headA,
  });

  const completed = await svc.workflowRuns.completeRun(
    repo.full_name,
    { run: started.run.id },
    parent,
  );
  expect(completed.run.status).toBe("completed");

  // A later commit advances HEAD past the reviewed SHA, so the passing review is now stale.
  const headB = commit(started.worktree, "more.txt", "extra\n");
  const staleStatus = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(staleStatus.head_sha).toBe(headB);
  expect(staleStatus.steps.verify.complete).toBe(false);
  expect(staleStatus.steps.verify.latest_review).toMatchObject({
    fresh: false,
  });
}, 30_000);

test("rework: request_changes -> address review -> turn done -> fresh Verify pass", async () => {
  const { repo } = freshRepo("me/workflow-rework");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Rework",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "rework-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent",
    },
    parent,
  );
  const prIssueId = S.getIssue(repo.id, started.pr.number)!.id;
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute", contract: "# Execute" },
    parent,
  );
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      sessionId: exec.session_id,
      agentName: exec.agent_name,
      pointers: exec.pointers,
    },
    parent,
  );

  const headA = commit(started.worktree, "impl.txt", "v1\n");
  svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  await svc.workflowRuns.advanceToVerify(
    repo.full_name,
    { run: started.run.id },
    parent,
  );

  // Verify requests changes, pinned to headA, with one finding.
  createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 1,
    event: "REQUEST_CHANGES",
    headSha: headA,
    body: "One change required.",
    findings: 1,
  });
  const rcStatus = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(rcStatus.steps.verify.latest_review).toMatchObject({
    event: "request_changes",
    fresh: true,
  });
  const reviewId = rcStatus.steps.verify.latest_review!.id;

  const rework = await svc.workflowRuns.requestRework(
    repo.full_name,
    { run: started.run.id },
    parent,
  );
  expect(rework.run).toMatchObject({
    current_step: "execute",
    rework_count: 1,
  });

  // The parent relaunches Execute with the review-id pointer; the pointer names the review, not a
  // summary of its findings.
  const rexec = await svc.workflowRuns.launchStep(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      review: reviewId,
      contract: "# Execute",
    },
    parent,
  );
  expect(rexec.pointers).toContainEqual({
    label: "address review",
    value: `#${reviewId}`,
  });
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      sessionId: rexec.session_id,
      agentName: rexec.agent_name,
      pointers: rexec.pointers,
    },
    parent,
  );

  // Execute pushes a fix (HEAD advances past the request_changes review), declares turn done, and
  // the run advances to a fresh Verify.
  const headB = commit(started.worktree, "fix.txt", "v2\n");
  svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    rexec.session_id,
  );
  const reworkedStatus = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  // The stale request_changes review no longer blocks execute (head advanced past it).
  expect(reworkedStatus.steps.execute.complete).toBe(true);
  await svc.workflowRuns.advanceToVerify(
    repo.full_name,
    { run: started.run.id },
    parent,
  );
  createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 2,
    event: "PASS",
    headSha: headB,
    body: "Fixed.",
  });
  const completed = await svc.workflowRuns.completeRun(
    repo.full_name,
    { run: started.run.id },
    parent,
  );
  expect(completed.run.status).toBe("completed");
}, 30_000);

test("turn done is rejected for a non-Execute session", async () => {
  const { repo } = freshRepo("me/workflow-turn");
  const issue = S.createIssue(repo.id, "issue", "Turn", "body", "me");
  const workflow = S.createWorkflow({
    name: "turn-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      parentContract: "# Parent",
    },
    parent,
  );
  const stranger = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  S.registerAgentSession(stranger, "workflow-step", stranger);
  expect(() =>
    svc.workflowRuns.turnDone(
      repo.full_name,
      { run: started.run.id },
      stranger,
    ),
  ).toThrowError(/launched Execute session/);
}, 20_000);

test("intent-based run lifecycle rejects invalid transitions and caps rework at 3", async () => {
  const { repo } = freshRepo("me/workflow-lifecycle");
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
  const prIssueId = S.getIssue(repo.id, started.pr.number)!.id;
  const lifecycleTransitions = () =>
    S.eventsForWorkflowRun(repo.id, started.run.id)
      .filter((event) => event.type === "workflow_run.updated")
      .map(
        (event) =>
          (JSON.parse(event.payload) as Record<string, unknown>).transition,
      );

  expect("update" in svc.workflowRuns).toBe(false);
  // Nothing committed yet: neither complete nor advance is legal.
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

  const headA = commit(started.worktree, "lifecycle.txt", "implemented\n");
  await svc.workflowRuns.advanceToVerify(
    repo.full_name,
    { run: started.run.id },
    parent,
  );
  // In Verify with no fresh review, completing is refused.
  await expect(
    svc.workflowRuns.completeRun(
      repo.full_name,
      { run: started.run.id },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });

  // Drive the rework budget to its cap. Each request_changes review is pinned to the current head,
  // and each rework advances the head so the next review is fresh again.
  let head = headA;
  for (let seq = 1; seq <= 3; seq++) {
    createWorkflowReview({
      prIssueId,
      runId: started.run.id,
      sequence: seq,
      event: "REQUEST_CHANGES",
      headSha: head,
      body: `Change ${seq}`,
      findings: 1,
    });
    const rework = await svc.workflowRuns.requestRework(
      repo.full_name,
      { run: started.run.id },
      parent,
    );
    expect(rework.run.rework_count).toBe(seq);
    head = commit(started.worktree, `fix-${seq}.txt`, `v${seq}\n`);
    await svc.workflowRuns.advanceToVerify(
      repo.full_name,
      { run: started.run.id },
      parent,
    );
  }

  // The 4th request_changes exceeds the cap.
  createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 4,
    event: "REQUEST_CHANGES",
    headSha: head,
    body: "Change 4",
    findings: 1,
  });
  await expect(
    svc.workflowRuns.requestRework(
      repo.full_name,
      { run: started.run.id },
      parent,
    ),
  ).rejects.toThrowError(/rework limit/);
  expect(S.getWorkflowRun(started.run.id)?.rework_count).toBe(3);

  // A fresh pass completes the run; a completed run refuses resume/stop.
  createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 5,
    event: "PASS",
    headSha: head,
    body: "All criteria pass.",
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

  expect(lifecycleTransitions()).toEqual([
    "advance_to_verify",
    "request_rework",
    "advance_to_verify",
    "request_rework",
    "advance_to_verify",
    "request_rework",
    "advance_to_verify",
    "complete",
  ]);
}, 40_000);

test("parent contract template drives transitions by observation, rework, and escalation", () => {
  const contract = readFileSync(
    join(import.meta.dirname, "workflow", "contracts", "parent.md"),
    "utf8",
  );
  // Allowed LoopHub / herdr commands are listed.
  expect(contract).toContain("lh workflow run complete");
  expect(contract).toContain("lh workflow run request-rework");
  expect(contract).toContain("lh workflow launch-step");
  expect(contract).toContain("lh workflow step status");
  expect(contract).toContain("herdr pane run");
  // Transitions come from observation; the turn-done notification is only a timing signal.
  expect(contract).toContain(
    "lh subscribe --repo '<repo>' --event workflow_run.turn_done",
  );
  expect(contract).toContain("only a signal to observe");
  expect(contract).toContain("Transitions are driven only by observation");
  expect(contract).toMatch(/never use pane output|PR body marker/i);
  // Idle detection is explicitly not used.
  expect(contract).toContain("You do **not** use idle detection");
  // The simplified observed transition table.
  expect(contract).toContain("launch Execute");
  expect(contract).toContain("execute complete");
  expect(contract).toContain("`pass`");
  expect(contract).toContain("`request_changes`");
  expect(contract).toContain("planning and reflection");
  // Rework increments the count, caps at 3, delivers a review-id pointer, and re-verifies fresh.
  expect(contract).toContain("run request-rework");
  expect(contract).toContain("would exceed 3");
  expect(contract).toContain("--step execute --review <id>");
  expect(contract).toMatch(/Verify as a\s+fresh child/u);
  // Escalation via issue comment + inbox + a resumable human hold; never the retired 'blocked'.
  expect(contract).toContain("lh issue comment");
  expect(contract).toContain("lh inbox send");
  expect(contract).toContain("run await-human");
  expect(contract).not.toContain("--status blocked");
  // Resume only on an explicit human instruction; skill independence.
  expect(contract).toContain("run resume");
  expect(contract).toContain("Never resume on your own");
  expect(contract).toContain("Do not call slash commands");
});

test("stateForIssue / stateForPull expose run display state, or null when absent (#1008)", async () => {
  const repo = S.createRepo("me/workflow-state", REPO_PATH);
  const issue = S.createIssue(repo.id, "issue", "Show run state", "body", "me");
  const prIssue = S.createIssue(repo.id, "pull", "PR for state", "body", "me");
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
    await svc.workflowRuns.stateForPull(repo.full_name, {
      pull: prIssue.number,
    }),
  ).toBeNull();

  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: prIssue.number,
    status: "running",
    currentStep: "verify",
    parentSessionId: "22222222-2222-4222-8222-222222222222",
  });
  S.updateWorkflowRun(run.id, { reworkCount: 2 });

  // The latest workflow review is surfaced as the display reason.
  createWorkflowReview({
    prIssueId: prIssue.id,
    runId: run.id,
    sequence: 1,
    event: "REQUEST_CHANGES",
    headSha: "0".repeat(40),
    body: "Two acceptance criteria are unmet.",
    findings: 2,
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
    pr_number: prIssue.number,
  });
  expect(byIssue?.latest_review).toMatchObject({
    event: "request_changes",
    summary: "Two acceptance criteria are unmet.",
    findings_count: 2,
  });

  const byPull = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(byPull?.id).toBe(run.id);
  expect(byPull?.needs_human_reason).toBeNull();

  S.updateWorkflowRun(run.id, { needsHumanReason: "waiting for guidance" });
  const waiting = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
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
  const latestUpdatedPayload = () => {
    const events = S.eventsForWorkflowRun(repo.id, run.id).filter(
      (event) => event.type === "workflow_run.updated",
    );
    return JSON.parse(events.at(-1)!.payload) as Record<string, unknown>;
  };

  expect(() =>
    svc.workflowRuns.awaitHuman(
      repo.full_name,
      { run: run.id, reason: "x".repeat(501) },
      parent,
    ),
  ).toThrowError(/500/);
  const held = svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run.id, reason: "rework limit\nexceeded" },
    parent,
  );
  expect(held.run.needs_human_reason).toBe("rework limit exceeded");
  expect(latestUpdatedPayload().needs_human_reason).toBe(
    "rework limit exceeded",
  );

  const stranger = "55555555-5555-4555-8555-555555555555";
  S.registerAgentSession(stranger, "workflow-step", stranger);
  expect(() =>
    svc.workflowRuns.stopRun(repo.full_name, { run: run.id }, stranger),
  ).toThrowError(/parent session/);
  const human = "66666666-6666-4666-8666-666666666666";
  S.registerAgentSession(human, "me", "cli");

  const resumed = await svc.workflowRuns.resumeAfterHuman(
    repo.full_name,
    { run: run.id, step: "execute" },
    human,
  );
  expect(resumed.run).toMatchObject({
    needs_human_reason: null,
    rework_count: 0,
  });
  expect(latestUpdatedPayload().needs_human_reason).toBeNull();
  expect("needs_human_reason" in latestUpdatedPayload()).toBe(true);

  // A human cancel of a held run ends terminal; the terminal payload omits the needs_human key.
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
  expect("needs_human_reason" in latestUpdatedPayload()).toBe(false);
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
    currentStep: "execute",
    parentSessionId: "44444444-4444-4444-8444-444444444444",
  });

  S.emitEvent(repo.id, "workflow_run.started", "parent", {
    id: run.id,
    issue_number: 10,
    pr_number: 20,
  });
  const firstInput = S.createHandoff({
    repoId: repo.id,
    phase: "execute",
    direction: "down",
    body: "## Inputs\n- repo: me/workflow-history\n\n## Note from parent\nFirst launch",
  });
  S.emitEvent(repo.id, "workflow_step.launched", "execute-agent", {
    id: run.id,
    step: "execute",
    handoff_id: firstInput.id,
    issue_number: 10,
    pr_number: 20,
  });
  S.emitEvent(repo.id, "workflow_run.turn_done", "execute-agent", {
    id: run.id,
    step: "execute",
    issue_number: 10,
    pr_number: 20,
  });
  S.emitEvent(repo.id, "workflow_run.updated", "parent", {
    id: run.id,
    transition: "advance_to_verify",
    status: "running",
    current_step: "verify",
    rework_count: 0,
    issue_number: 10,
    pr_number: 20,
  });
  const secondInput = S.createHandoff({
    repoId: repo.id,
    phase: "execute",
    direction: "down",
    body: "## Inputs\n- repo: me/workflow-history\n\n## Note from parent\nSecond launch",
  });
  S.emitEvent(repo.id, "workflow_step.launched", "execute-agent-2", {
    id: run.id,
    step: "execute",
    handoff_id: secondInput.id,
    issue_number: 10,
    pr_number: 20,
  });
  // A different run in the same PR namespace must not leak into this run's history.
  S.emitEvent(repo.id, "workflow_step.launched", "other-agent", {
    id: otherRun.id,
    step: "execute",
    issue_number: 10,
    pr_number: 20,
  });

  const history = svc.workflowRuns.history(repo.full_name, { run: run.id });
  expect(history.map((event) => event.type)).toEqual([
    "workflow_run.started",
    "workflow_step.launched",
    "workflow_run.turn_done",
    "workflow_run.updated",
    "workflow_step.launched",
  ]);
  expect(history.map((event) => event.label)).toEqual([
    "Run started",
    "Execute step started",
    "Turn done declared",
    "Run advanced to Verify",
    "Execute step started",
  ]);
  expect(history[2].description).toContain("declared its turn done");
  expect(history[1].input).toContain("First launch");
  expect(history[4].input).toContain("Second launch");
  expect(history[0].input).toBeNull();
});

test("stall sweep surfaces a stuck run to a human and is idempotent (#1358)", async () => {
  const repo = S.createRepo("me/workflow-stall", REPO_PATH);
  const workflow = S.createWorkflow({
    name: "stall-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 30,
    prNumber: 31,
    status: "running",
    currentStep: "execute",
    parentSessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });
  S.emitEvent(repo.id, "workflow_run.started", "parent", {
    id: run.id,
    issue_number: 30,
    pr_number: 31,
  });
  const activityAt = Date.parse(
    S.latestWorkflowRunActivityAt(repo.id, run.id)!,
  );

  // A run with recent activity is not held.
  const fresh = svc.workflowRuns.sweepStalledRuns({
    thresholdMs: 30 * 60_000,
    now: activityAt + 60_000,
  });
  expect(fresh.held).not.toContain(run.id);
  expect(S.getWorkflowRun(run.id)?.needs_human_reason).toBeNull();

  // Past the threshold, the run is held needs-human and a human-facing Inbox message is filed.
  const held = svc.workflowRuns.sweepStalledRuns({
    thresholdMs: 30 * 60_000,
    now: activityAt + 31 * 60_000,
  });
  expect(held.held).toContain(run.id);
  const stalled = S.getWorkflowRun(run.id)!;
  expect(stalled.status).toBe("running");
  expect(stalled.needs_human_reason).toMatch(/no turn-done/);
  const inbox = svc.inbox.list(repo.full_name, {});
  expect(
    inbox.some((message: { title: string }) =>
      message.title.includes(`run #${run.id} stalled`),
    ),
  ).toBe(true);

  // Idempotent: an already-held run is skipped on the next sweep.
  const again = svc.workflowRuns.sweepStalledRuns({
    thresholdMs: 30 * 60_000,
    now: activityAt + 62 * 60_000,
  });
  expect(again.held).not.toContain(run.id);
});
