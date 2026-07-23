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
let A: typeof import("./attachments.ts");

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
  A = await import("./attachments.ts");
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
  expect(S.getWorkflowRun(result.run.id)).toMatchObject({
    cost_increment_usd: 10,
    cost_limit_usd: 10,
  });
  svc.settings.update({ devCostLimitUsd: 1 });
  expect(S.getWorkflowRun(result.run.id)).toMatchObject({
    cost_increment_usd: 10,
    cost_limit_usd: 10,
  });
  svc.settings.update({ devCostLimitUsd: 10 });
  expect(result.pr.number).toBeGreaterThan(issue.number);
  expect(existsSync(result.worktree)).toBe(true);
  expect(existsSync(result.lock_path)).toBe(true);

  const parentSystemPrompt = readFileSync(
    result.parent.system_prompt_path,
    "utf8",
  );
  expect(parentSystemPrompt).toContain("step: parent");
  expect(parentSystemPrompt).toContain("# Parent workflow contract");
  // start wires this run's own identifiers into the parent prompt; its wording and the transition
  // commands it carries are covered by core/workflow/prompts.test.ts.
  expect(result.parent.user_prompt).toContain(`run: ${result.run.id}`);
  expect(result.parent.user_prompt).toContain(`issue: #${result.issue.number}`);
  expect(result.parent.user_prompt).toContain(`pr: #${result.pr.number}`);
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
      { run: result.run.id, step: "execute" },
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
      model: "sonnet",
      note: "Read the issue first.",
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
  expect(launched.herdr.command).toContain("'--permission-mode' 'auto'");
  expect(launched.agent_name).toBe(`executor #${result.run.id}-1`);

  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: result.run.id,
      step: launched.step,
      sessionId: launched.session_id,
      agentName: launched.agent_name,
      pointers: launched.pointers,
      note: "Read the issue first.",
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
      body: [
        `Launch Workflow execute step for run #${result.run.id}.`,
        "",
        "## Inputs",
        `- repo: ${repo.full_name}`,
        `- issue: #${result.issue.number}`,
        `- pr: #${result.pr.number}`,
        "",
        "## Note from parent",
        "Read the issue first.",
      ].join("\n"),
      summary: "Launch execute step",
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
      runtime: "codex",
      model: "gpt-5.5",
    },
    "33333333-3333-4333-8333-333333333333",
  );

  const row = S.getWorkflowRun(result.run.id)!;
  expect(row.runtime).toBe("codex");
  expect(row.model).toBe("gpt-5.5");
  expect(result.parent.user_prompt).toContain("--since <cursor>");
  expect(result.parent.user_prompt).toContain(
    "runtime-managed background task",
  );
  expect(result.parent.user_prompt).toContain(
    "Runtime-specific tool mechanics belong to the runtime adapter",
  );
  expect(S.getAgentSession(result.session_id)?.runtime).toBe("codex");

  const launched = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: result.run.id, step: "execute" },
    result.session_id,
  );
  expect(launched.runtime).toBe("codex");
  expect(launched.herdr.command).toContain("codex ");
  expect(launched.herdr.command).not.toContain("claude");
  expect(launched.herdr.command).not.toContain("--session-id");
  expect(launched.herdr.command).toContain("'--model' 'gpt-5.5'");

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

test("start snapshots the contract language for parent and every later step", async () => {
  const { repo } = freshRepo("me/workflow-language-run");
  const issue = S.createIssue(repo.id, "issue", "Japanese run", "", "me");
  const workflow = S.createWorkflow({
    name: "language-standard",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });

  svc.settings.update({ workflowContractLanguage: "ja" });
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    "77777777-7777-4777-8777-777777777777",
  );
  svc.settings.update({ workflowContractLanguage: "en" });

  expect(S.getWorkflowRun(started.run.id)?.contract_language).toBe("ja");
  expect(started.parent.user_prompt).toContain("## Run コンテキスト");
  expect(started.parent.user_prompt).toContain("## 指示");
  expect(readFileSync(started.parent.system_prompt_path, "utf8")).toContain(
    "# Parent workflow contract",
  );
  expect(readFileSync(started.parent.system_prompt_path, "utf8")).toContain(
    "## Workflow contract コンテキスト",
  );
  expect(readFileSync(started.parent.system_prompt_path, "utf8")).toContain(
    "## 言語",
  );
  const execute = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
    started.session_id,
  );
  expect(readFileSync(execute.system_prompt_path, "utf8")).toContain(
    "# Execute ステップ contract",
  );
  expect(execute.user_prompt).toContain("## Step prompt（ユーザー設定）");
  expect(execute.user_prompt).toContain("(none - contract に従ってください)");
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    started.session_id,
  );
  expect(readFileSync(verify.system_prompt_path, "utf8")).toContain(
    "# Verify ステップ contract",
  );
  expect(verify.pointers.at(-1)?.label).toBe(
    "review submission target (do not read the PR)",
  );

  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: execute.step,
      sessionId: execute.session_id,
      pointers: execute.pointers,
      note: "Issue を先に読んでください。",
    },
    started.session_id,
  );
  expect(
    S.listHandoffs(repo.id, {
      prId: S.getIssue(repo.id, started.pr.number)!.id,
    }),
  ).toEqual([
    expect.objectContaining({
      body: [
        `Workflow execute step を run #${started.run.id} 向けに起動します。`,
        "",
        "## 入力",
        `- repo: ${repo.full_name}`,
        `- issue: #${issue.number}`,
        `- pr: #${started.pr.number}`,
        "",
        "## Parent からの note",
        "Issue を先に読んでください。",
      ].join("\n"),
      summary: "execute step を起動",
    }),
  ]);
});

test("cost limit increases are explicit, guarded, and repeatable", async () => {
  const repo = S.createRepo("me/workflow-cost-limit", REPO_PATH);
  const pull = S.createIssue(repo.id, "pull", "Cost-limited PR", "", "me");
  S.createPull(pull.id, "cost-limit", "main", null);
  const workflow = S.createWorkflow({
    name: "cost-limit-workflow",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parentSessionId = "77777777-7777-4777-8777-777777777777";
  const childSessionId = "88888888-8888-4888-8888-888888888888";
  S.registerAgentSession(parentSessionId, "lh-workflow", parentSessionId);
  S.registerAgentSession(childSessionId, "workflow-step", childSessionId);
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: pull.number,
    prNumber: pull.number,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 2.5,
    costLimitUsd: 2.5,
    parentSessionId,
  });
  S.appendWorkflowRunStepSession(run.id, "execute", childSessionId);
  S.updateWorkflowRun(run.id, {
    activeStep: "execute",
    activeSessionId: childSessionId,
  });
  S.upsertSessionUsage(childSessionId, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 3,
  });

  expect(
    svc.workflowRuns.detectCostExceeded(repo.full_name, {
      run: run.id,
      usageSession: childSessionId,
    }),
  ).toEqual({ emitted: true, cost_usd: 3, limit_usd: 2.5 });
  expect(
    svc.workflowRuns.detectCostExceeded(repo.full_name, {
      run: run.id,
      usageSession: childSessionId,
    }),
  ).toEqual({ emitted: false, cost_usd: 3, limit_usd: 2.5 });
  const firstEvent = S.eventsForWorkflowRun(repo.id, run.id).find(
    (event) => event.type === "workflow_run.cost_exceeded",
  );
  expect(JSON.parse(firstEvent!.payload)).toMatchObject({
    cost_usd: 3,
    limit_usd: 2.5,
    increment_usd: 2.5,
    next_limit_usd: 5,
  });

  expect(() =>
    svc.workflowRuns.increaseCostLimit(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      parentSessionId,
    ),
  ).toThrow("Workflow run is not waiting for a human");
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run.id, reason: "Cost limit exceeded" },
    parentSessionId,
  );
  expect(() =>
    svc.workflowRuns.increaseCostLimit(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 1 },
      parentSessionId,
    ),
  ).toThrow("does not match current limit");
  expect(
    svc.workflowRuns.increaseCostLimit(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      parentSessionId,
    ),
  ).toEqual({
    run: run.id,
    increment_usd: 2.5,
    previous_limit_usd: 2.5,
    current_limit_usd: 5,
  });
  expect(() =>
    svc.workflowRuns.increaseCostLimit(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      parentSessionId,
    ),
  ).toThrow("does not match current limit");

  const resumed = await svc.workflowRuns.resumeAfterHuman(
    repo.full_name,
    { run: run.id, step: "execute" },
    parentSessionId,
  );
  expect(resumed.run.needs_human_reason).toBeNull();
  expect(S.getWorkflowRun(run.id)?.cost_limit_usd).toBe(5);
  S.upsertSessionUsage(childSessionId, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 5.5,
  });
  expect(
    svc.workflowRuns.detectCostExceeded(repo.full_name, {
      run: run.id,
      usageSession: childSessionId,
    }),
  ).toEqual({ emitted: true, cost_usd: 5.5, limit_usd: 5 });
  const costEvents = S.eventsForWorkflowRun(repo.id, run.id).filter(
    (event) => event.type === "workflow_run.cost_exceeded",
  );
  expect(costEvents).toHaveLength(2);
  expect(JSON.parse(costEvents[1].payload)).toMatchObject({
    limit_usd: 5,
    increment_usd: 2.5,
    next_limit_usd: 7.5,
  });
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run.id, reason: "Cost limit exceeded again" },
    parentSessionId,
  );
  expect(
    svc.workflowRuns.increaseCostLimit(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 5 },
      parentSessionId,
    ),
  ).toMatchObject({ previous_limit_usd: 5, current_limit_usd: 7.5 });

  const heldWithoutEvent = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: pull.number,
    prNumber: pull.number,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 2.5,
    costLimitUsd: 2.5,
    parentSessionId,
  });
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: heldWithoutEvent.id, reason: "Ordinary human hold" },
    parentSessionId,
  );
  expect(() =>
    svc.workflowRuns.increaseCostLimit(
      repo.full_name,
      { run: heldWithoutEvent.id, expectedLimitUsd: 2.5 },
      parentSessionId,
    ),
  ).toThrow("no cost exceeded event exists");
  expect(S.getWorkflowRun(heldWithoutEvent.id)).toMatchObject({
    cost_increment_usd: 2.5,
    cost_limit_usd: 2.5,
  });
  await svc.workflowRuns.resumeAfterHuman(
    repo.full_name,
    { run: heldWithoutEvent.id, step: "execute" },
    parentSessionId,
  );
  expect(S.getWorkflowRun(heldWithoutEvent.id)).toMatchObject({
    needs_human_reason: null,
    cost_increment_usd: 2.5,
    cost_limit_usd: 2.5,
  });
});

test("a grok run's steps launch grok, not claude (#1521)", async () => {
  const repo = S.getRepo("me", "workflow-run")!;
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Grok run",
    "## Acceptance criteria\n- [ ] It works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "grok-standard",
    description: "",
    executePrompt: "Plan and implement it.",
    verifyPrompt: "",
  });

  const result = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
      runtime: "grok",
      model: "grok-code-fast-1",
    },
    "12121212-1212-4121-8121-121212121212",
  );

  const row = S.getWorkflowRun(result.run.id)!;
  expect(row.runtime).toBe("grok");
  expect(row.model).toBe("grok-code-fast-1");
  expect(S.getAgentSession(result.session_id)?.runtime).toBe("grok");

  const launched = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: result.run.id, step: "execute" },
    result.session_id,
  );
  expect(launched.runtime).toBe("grok");
  expect(launched.herdr.command).toContain("grok ");
  expect(launched.herdr.command).not.toContain("claude");
  expect(launched.herdr.command).not.toContain("--session-id");
  expect(launched.herdr.command).toContain("'--model' 'grok-code-fast-1'");

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
  expect(S.getAgentSession(launched.session_id)?.runtime).toBe("grok");
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
    },
    "44444444-4444-4444-8444-444444444444",
  );

  const row = S.getWorkflowRun(result.run.id)!;
  expect(row.runtime).toBe("claude-code");
  expect(row.model).toBeNull();

  const launched = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: result.run.id, step: "execute" },
    result.session_id,
  );
  expect(launched.runtime).toBe("claude-code");
  expect(launched.herdr.command).toContain("claude '--session-id'");
  expect(launched.herdr.command).toContain("'--model' 'opus'");
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
    },
    parent,
  );
  const prIssueId = S.getIssue(repo.id, started.pr.number)!.id;

  const eventCountBeforeNext = S.eventsForWorkflowRun(
    repo.id,
    started.run.id,
  ).length;
  const initialNext = await svc.workflowRuns.next(repo.full_name, {
    run: started.run.id,
  });
  expect(initialNext.action).toBe("launch_execute");
  expect(
    await svc.workflowRuns.next(repo.full_name, { run: started.run.id }),
  ).toEqual(initialNext);
  expect(S.eventsForWorkflowRun(repo.id, started.run.id)).toHaveLength(
    eventCountBeforeNext,
  );
  expect(S.getWorkflowRun(started.run.id)).toMatchObject({
    current_step: "execute",
    rework_count: 0,
  });

  // Launch + confirm the Execute child.
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
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
  const before = await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  expect(before.event_id).toBeGreaterThan(0);
  let status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.last_turn_done_at).not.toBeNull();
  expect(status.turn_done_for_active_execute).toBe(true);
  expect(status.head_ahead_of_base).toBe(false);
  expect(status.steps.execute.complete).toBe(false);
  expect(
    await svc.workflowRuns.next(repo.full_name, { run: started.run.id }),
  ).toMatchObject({
    action: "deliver",
    delivery_reason: "no_progress",
  });
  await expect(
    svc.workflowRuns.advanceToVerify(
      repo.full_name,
      { run: started.run.id },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });

  // Delivering a recovery instruction starts a new Execute round. The previous turn-done must not
  // carry into that round: neither activation nor a commit is enough until Execute declares the
  // new turn done.
  svc.workflowRuns.activateStep(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      sessionId: exec.session_id,
    },
    parent,
  );
  expect(
    await svc.workflowRuns.status(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ turn_done_for_active_execute: false });
  expect(
    await svc.workflowRuns.next(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ action: "wait" });
  const headA = commit(started.worktree, "impl.txt", "done\n");
  expect(
    await svc.workflowRuns.status(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ turn_done_for_active_execute: false });
  expect(
    await svc.workflowRuns.next(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ action: "wait" });

  // Execute declares the new turn done. Now HEAD is ahead of base.
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.head_ahead_of_base).toBe(true);
  expect(status.steps.execute.complete).toBe(true);
  expect(
    await svc.workflowRuns.next(repo.full_name, { run: started.run.id }),
  ).toMatchObject({
    action: "advance_and_verify",
    transition: "advance_to_verify",
  });

  await svc.workflowRuns.advanceToVerify(
    repo.full_name,
    { run: started.run.id },
    parent,
  );

  // Verify submits a passing review pinned to the reviewed head.
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      sessionId: verify.session_id,
      agentName: verify.agent_name,
      pointers: verify.pointers,
      headSha: verify.head_sha,
    },
    parent,
  );
  expect(verify.head_sha).toBe(headA);
  expect(verify.base_sha).toBe(
    gitAt(started.worktree, ["merge-base", "main", headA]),
  );
  expect(
    await svc.workflowRuns.next(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ action: "wait" });
  // Verify pointers are the fixed triple plus the review target — never a task/diff file.
  expect(verify.pointers.map((p) => p.label)).toEqual([
    "repo",
    "issue",
    "base sha",
    "head sha",
    "review submission target (do not read the PR)",
  ]);
  const passReview = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    {
      event: "PASS",
      topic: "workflow",
      headSha: headA,
      body: "All criteria pass.",
    },
    verify.session_id,
  );

  // Regression for run 82: registering the fresh review itself emits a parent observation trigger.
  // Verify does not need a later turn-done declaration, and the event carries only run pointers —
  // the persisted review remains the verdict source.
  const reviewEvent = S.listEvents(0, repo.id, 100).find(
    (event) => event.type === "workflow_run.review_submitted",
  );
  expect(reviewEvent).toBeDefined();
  expect(JSON.parse(reviewEvent!.payload)).toEqual({
    id: started.run.id,
    number: started.pr.number,
    issue_number: issue.number,
    pr_number: started.pr.number,
    parent_session_id: parent,
    session_id: verify.session_id,
    review_id: passReview.id,
    submission_head_sha: headA,
  });

  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.complete).toBe(true);
  expect(status.steps.verify.latest_review).toMatchObject({
    id: passReview.id,
    event: "pass",
    fresh: true,
    headSha: headA,
  });
  expect(
    await svc.workflowRuns.next(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ action: "wait" });

  // A live Execute injection after a fresh pass keeps lifecycle at Verify, but records the actual
  // child that receives pane input. Cost detection must target that executor, not the last verifier.
  const activated = svc.workflowRuns.activateStep(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      sessionId: exec.session_id,
    },
    parent,
  );
  expect(activated.run).toMatchObject({
    current_step: "verify",
    active_step: "execute",
    active_session_id: exec.session_id,
  });
  S.upsertSessionUsage(parent, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 11,
  });
  expect(
    svc.workflowRuns.detectCostExceeded(repo.full_name, {
      run: started.run.id,
      usageSession: parent,
    }),
  ).toMatchObject({ emitted: true, cost_usd: 11, limit_usd: 10 });
  const costEvent = S.listEvents(0, repo.id, 100).find(
    (event) => event.type === "workflow_run.cost_exceeded",
  );
  expect(JSON.parse(costEvent!.payload)).toMatchObject({
    usage_session_id: parent,
    active_step: "execute",
    active_session_id: exec.session_id,
  });

  // A human can request ordinary additional work while the pass is fresh. The run is not held and
  // remains at Verify; the parent may launch and register another Execute child with the human note.
  const additionalExecute = await svc.workflowRuns.launchStep(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      note: "Add another requested change.",
    },
    parent,
  );
  expect(additionalExecute.run).toMatchObject({
    status: "running",
    current_step: "verify",
    needs_human_reason: null,
  });
  expect(additionalExecute.user_prompt).toContain(
    "Add another requested change.",
  );
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      sessionId: additionalExecute.session_id,
      agentName: additionalExecute.agent_name,
      pointers: additionalExecute.pointers,
      note: "Add another requested change.",
    },
    parent,
  );

  // A passing review verifies the current HEAD without terminating the run. Uploading an
  // attachment and embedding it in the PR body are non-code edits: neither moves HEAD, so the same
  // pass remains fresh and the parent can keep observing this run.
  const attachment = A.saveAttachment({
    data: Buffer.from("workflow evidence"),
    filename: "workflow-evidence.png",
    mime: "image/png",
    author: "execute-agent",
  });
  expect(A.getAttachment(attachment.sha256)).toMatchObject({
    filename: "workflow-evidence.png",
    author: "execute-agent",
  });
  S.updateIssue(prIssueId, {
    body: `Updated evidence after Verify passed.\n\n${attachment.markdown}\n`,
  });
  let continuing = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(continuing.status).toBe("running");
  expect(continuing.head_sha).toBe(headA);
  expect(continuing.steps.verify.latest_review).toMatchObject({
    event: "pass",
    fresh: true,
  });

  // A later commit advances HEAD past the reviewed SHA, so the passing review is now stale.
  const headB = commit(started.worktree, "more.txt", "extra\n");
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    additionalExecute.session_id,
  );
  const staleStatus = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(staleStatus.head_sha).toBe(headB);
  expect(staleStatus.steps.verify.complete).toBe(false);
  expect(staleStatus.steps.verify.latest_review).toMatchObject({
    fresh: false,
  });

  // The run is already at Verify, so the parent launches a fresh verifier directly. Its pass is
  // pinned to headB, and the run continues waiting for another event.
  const freshVerify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  expect(freshVerify.head_sha).toBe(headB);
  createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 2,
    event: "PASS",
    headSha: headB,
    body: "Additional work passes.",
  });
  continuing = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(continuing.status).toBe("running");
  expect(continuing.steps.verify.latest_review).toMatchObject({
    event: "pass",
    fresh: true,
    headSha: headB,
  });
}, 30_000);

test("step status exposes hold, rework, pending effects, and unaddressed out-of-band reviews", async () => {
  const { repo } = freshRepo("me/workflow-observed-state");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Observed state",
    "## Acceptance criteria\n- [ ] State is complete\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "observed-state-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "71717171-7171-4171-8171-717171717171";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const prIssue = S.getIssue(repo.id, started.pr.number)!;
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
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

  let status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status).toMatchObject({
    awaiting_human: false,
    needs_human_reason: null,
    rework_count: 0,
    rework_limit: 3,
    pending_effect_receipt: null,
    unaddressed_out_of_band_reviews: [],
  });

  const runEvent = S.eventsForWorkflowRun(repo.id, started.run.id).find(
    (event) => event.type.startsWith("workflow_run."),
  )!;
  S.beginWorkflowEventEffect(started.run.id, runEvent.id, "notify-observer");
  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.pending_effect_receipt).toMatchObject({
    event_id: runEvent.id,
    effect: "notify-observer",
    status: "pending",
  });
  expect(
    await svc.workflowRuns.next(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ action: "wait" });

  S.completeWorkflowEventEffect(started.run.id, runEvent.id, "notify-observer");
  const reviewedHead = gitAt(started.worktree, ["rev-parse", "HEAD"]);
  commit(started.worktree, "before-feedback.txt", "already advanced\n");
  S.createReview(
    prIssue.id,
    "historical-human",
    "FEEDBACK",
    "This review predates the run-scoped submission boundary.",
    reviewedHead,
  );
  const feedback = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    {
      event: "FEEDBACK",
      topic: "workflow",
      headSha: reviewedHead,
      body: "Please account for this.",
    },
    "human-observer",
  );
  const requestedChanges = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    {
      event: "REQUEST_CHANGES",
      topic: "security",
      headSha: reviewedHead,
      body: "Please fix this too.",
    },
    "human-observer",
  );
  createWorkflowReview({
    prIssueId: prIssue.id,
    runId: started.run.id,
    sequence: 1,
    event: "REQUEST_CHANGES",
    headSha: reviewedHead,
    body: "Run-owned review stays on the Verify path.",
  });

  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.pending_effect_receipt).toBeNull();
  expect(status.unaddressed_out_of_band_reviews).toEqual([
    { id: feedback.id, verdict: "feedback" },
    { id: requestedChanges.id, verdict: "request_changes" },
  ]);
  expect(
    await svc.workflowRuns.next(repo.full_name, { run: started.run.id }),
  ).toMatchObject({
    action: "deliver",
    delivery_reason: "out_of_band_review",
    review_id: feedback.id,
  });

  // A turn done with the same HEAD observed at review submission does not address feedback pinned
  // to an older SHA: the progress must happen after the submission boundary.
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.unaddressed_out_of_band_reviews).toHaveLength(2);

  commit(started.worktree, "feedback.txt", "addressed\n");
  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.unaddressed_out_of_band_reviews).toHaveLength(2);
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.unaddressed_out_of_band_reviews).toEqual([]);

  // Active runs created before submission/turn-done HEADs were added can still make progress:
  // the pinned review SHA is the conservative submission boundary, and a new turn done records
  // the addressed HEAD in the current format.
  const legacyHead = gitAt(started.worktree, ["rev-parse", "HEAD"]);
  const legacyFeedback = S.createReview(
    prIssue.id,
    "legacy-human",
    "FEEDBACK",
    "Legacy feedback",
    legacyHead,
  );
  S.emitEvent(repo.id, "workflow_run.review_submitted", "legacy-human", {
    id: started.run.id,
    review_id: legacyFeedback.id,
  });
  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.unaddressed_out_of_band_reviews).toEqual([
    { id: legacyFeedback.id, verdict: "feedback" },
  ]);
  commit(started.worktree, "legacy-feedback.txt", "addressed\n");
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status.unaddressed_out_of_band_reviews).toEqual([]);

  S.updateWorkflowRun(started.run.id, {
    needsHumanReason: "waiting for guidance",
    reworkCount: 2,
  });
  status = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(status).toMatchObject({
    awaiting_human: true,
    needs_human_reason: "waiting for guidance",
    rework_count: 2,
    rework_limit: 3,
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
    },
    parent,
  );
  const prIssueId = S.getIssue(repo.id, started.pr.number)!.id;
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
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
  await svc.workflowRuns.turnDone(
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
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  svc.workflowRuns.confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      sessionId: verify.session_id,
      agentName: verify.agent_name,
      pointers: verify.pointers,
      headSha: verify.head_sha,
    },
    parent,
  );
  await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    {
      event: "REQUEST_CHANGES",
      topic: "workflow",
      headSha: headA,
      body: "One change required.",
      comments: [{ path: "file-0.ts", line: 1, body: "needs a fix" }],
    },
    verify.session_id,
  );
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
  await svc.workflowRuns.turnDone(
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
  // The fresh pass verifies the reworked HEAD without terminating the run: it stays `running` and
  // the parent keeps observing (#1513 — no run-complete path).
  const reworked = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(reworked.status).toBe("running");
  expect(reworked.steps.verify.latest_review).toMatchObject({
    event: "pass",
    fresh: true,
    headSha: headB,
  });
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
    },
    parent,
  );
  const stranger = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  S.registerAgentSession(stranger, "workflow-step", stranger);
  await expect(
    svc.workflowRuns.turnDone(
      repo.full_name,
      { run: started.run.id },
      stranger,
    ),
  ).rejects.toThrowError(/launched Execute session/);
}, 20_000);

test("Execute escalation records a validated event without changing run lifecycle", async () => {
  const { repo } = freshRepo("me/workflow-escalate");
  const issue = S.createIssue(repo.id, "issue", "Escalate", "body", "me");
  const workflow = S.createWorkflow({
    name: "escalate-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflowId: workflow.id,
    },
    parent,
  );
  const execute = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  S.registerAgentSession(execute, "workflow-step", execute);
  S.appendWorkflowRunStepSession(started.run.id, "execute", execute);

  const result = svc.workflowRuns.escalate(
    repo.full_name,
    {
      run: started.run.id,
      reason: "  See issue comment #12.\nPlease advise.  ",
    },
    execute,
  );
  expect(result.run).toBe(started.run.id);
  expect(S.getWorkflowRun(started.run.id)).toMatchObject({
    status: "running",
    current_step: "execute",
    needs_human_reason: null,
  });
  const event = S.eventsForWorkflowRun(repo.id, started.run.id).find(
    (item) => item.id === result.event_id,
  );
  expect(event?.type).toBe("workflow_run.escalated");
  expect(JSON.parse(event!.payload)).toMatchObject({
    id: started.run.id,
    issue_number: issue.number,
    pr_number: started.pr.number,
    parent_session_id: parent,
    session_id: execute,
    reason: "See issue comment #12. Please advise.",
  });

  expect(() =>
    svc.workflowRuns.escalate(
      repo.full_name,
      { run: started.run.id, reason: "\n\t" },
      execute,
    ),
  ).toThrowError(/requires a reason/);
  expect(() =>
    svc.workflowRuns.escalate(
      repo.full_name,
      { run: started.run.id, reason: "x".repeat(501) },
      execute,
    ),
  ).toThrowError(/at most 500 characters/);
  expect(() =>
    svc.workflowRuns.escalate(
      repo.full_name,
      { run: started.run.id, reason: "help" },
      "00000000-0000-4000-8000-000000000000",
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
  expect("completeRun" in svc.workflowRuns).toBe(false);
  // Nothing committed yet: advancing to Verify is illegal (Execute is incomplete).
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

  // A fresh pass verifies the current HEAD without terminating the run (#1513): it stays `running`,
  // so resume is refused (no human wait). There is no run-stop transition anymore (#1525).
  createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 5,
    event: "PASS",
    headSha: head,
    body: "All criteria pass.",
  });
  const passed = await svc.workflowRuns.status(repo.full_name, {
    run: started.run.id,
  });
  expect(passed.status).toBe("running");
  expect(passed.steps.verify.latest_review).toMatchObject({
    event: "pass",
    fresh: true,
    headSha: head,
  });
  await expect(
    svc.workflowRuns.resumeAfterHuman(
      repo.full_name,
      { run: started.run.id, step: "execute" },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect("stopRun" in svc.workflowRuns).toBe(false);

  expect(lifecycleTransitions()).toEqual([
    "advance_to_verify",
    "request_rework",
    "advance_to_verify",
    "request_rework",
    "advance_to_verify",
    "request_rework",
    "advance_to_verify",
  ]);
}, 40_000);

test("parent contract template drives transitions by observation, rework, and escalation", () => {
  const contract = readFileSync(
    join(import.meta.dirname, "workflow", "contracts", "parent.md"),
    "utf8",
  );
  // Allowed LoopHub commands are listed.
  expect(contract).not.toContain("lh workflow run complete");
  expect(contract).toContain("lh workflow run request-rework");
  expect(contract).toContain("lh workflow launch-step");
  expect(contract).toContain("lh workflow step status");
  expect(contract).toContain("herdr pane run");
  expect(contract).toContain("record its printed `agent` and `session` lines");
  // Transitions come from observation; watcher events only wake reconciliation.
  expect(contract).toContain(
    "lh workflow watch --repo '<repo>' --run <run> --since <cursor> --json",
  );
  expect(contract).toContain(
    "start the exact returned `next_command` unchanged",
  );
  expect(contract).not.toContain("--ack");
  expect(contract).not.toContain("replay the event");
  expect(contract).not.toContain("lh subscribe --repo");
  expect(contract).toContain("## Goal");
  expect(contract).toContain("## Reconcile loop");
  expect(contract).toContain("## Gap table");
  expect(contract).toMatch(/never use pane output|PR body marker/i);
  expect(contract).toContain("Do not use child-session");
  expect(contract).not.toContain("lh workflow run enforce-cost-limit");
  // The simplified observed gap table.
  expect(contract).toContain("launch Execute");
  expect(contract).toContain("Execute HEAD is ahead of base");
  expect(contract).toContain("`pass`");
  expect(contract).toContain("stays `running` after reaching the goal");
  expect(contract).toContain("launch Verify for the current HEAD");
  expect(contract).toContain("--note <text|->");
  expect(contract).toContain("lh workflow run resume");
  expect(contract).toContain("`request_changes`");
  // Rework increments the count, caps at 3, delivers a review-id pointer, and re-verifies fresh.
  expect(contract).toContain("lh workflow run request-rework");
  expect(contract).toContain("The rework limit is 3");
  expect(contract).toContain("--step execute --review <id>");
  expect(contract).toContain("Verify is **always a fresh child**");
  // Escalation uses issue comment + inbox while the parent waits for human input.
  expect(contract).toContain("lh issue comment");
  expect(contract).toContain("lh inbox send");
  expect(contract).toContain("run await-human");
  expect(contract).toContain("The run stays `running` after reaching the goal");
  expect(contract).not.toContain("--status blocked");
  // The parent stays alive instead of resuming a child session.
  expect(contract).toContain("Do not use child-session");
});

test("stateForIssue / stateForPull expose run display state, or null when absent (#1008)", async () => {
  const repo = S.createRepo("me/workflow-state", REPO_PATH);
  const issue = S.createIssue(repo.id, "issue", "Show run state", "body", "me");
  const prIssue = S.createIssue(repo.id, "pull", "PR for state", "body", "me");
  const reviewedHead = "0".repeat(40);
  S.createPull(prIssue.id, "state-head", "main", reviewedHead, issue.id);
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
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: "22222222-2222-4222-8222-222222222222",
  });
  S.updateWorkflowRun(run.id, { reworkCount: 2 });

  // The latest workflow review is surfaced as the display reason.
  createWorkflowReview({
    prIssueId: prIssue.id,
    runId: run.id,
    sequence: 1,
    event: "REQUEST_CHANGES",
    headSha: reviewedHead,
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
  expect(byIssue?.verification_status).toBe("unverified");

  const byPull = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(byPull?.id).toBe(run.id);
  expect(byPull?.needs_human_reason).toBeNull();

  createWorkflowReview({
    prIssueId: prIssue.id,
    runId: run.id,
    sequence: 2,
    event: "PASS",
    headSha: reviewedHead,
    body: "Current HEAD passes.",
  });
  expect(
    svc.workflowRuns.stateForPull(repo.full_name, { pull: prIssue.number })
      ?.verification_status,
  ).toBe("verified");
  S.setHeadSha(prIssue.id, "1".repeat(40));
  expect(
    svc.workflowRuns.stateForPull(repo.full_name, { pull: prIssue.number })
      ?.verification_status,
  ).toBe("stale");

  S.updateWorkflowRun(run.id, { needsHumanReason: "waiting for guidance" });
  const waiting = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(waiting?.needs_human_reason).toBe("waiting for guidance");
});

test("human lifecycle intents sanitize reasons and authorize explicit resume (#1307)", async () => {
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
    costIncrementUsd: 10,
    costLimitUsd: 10,
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
  await expect(
    svc.workflowRuns.resumeAfterHuman(
      repo.full_name,
      { run: run.id, step: "execute" },
      stranger,
    ),
  ).rejects.toThrowError(/parent session/);
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
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: "33333333-3333-4333-8333-333333333333",
  });
  const otherRun = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 10,
    prNumber: 20,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 10,
    costLimitUsd: 10,
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
