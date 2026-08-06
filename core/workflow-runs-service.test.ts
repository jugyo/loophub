import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-runs-"));
const REPO_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-runs-repo-"));
// A rework injects into the Execute pane, so the pane control has a fake herdr to talk to.
const BIN_PATH = mkdtempSync(join(tmpdir(), "lh-workflow-runs-bin-"));
const HERDR_LOG = join(HOME, "herdr.log");
const ORIGINAL_PATH = process.env.PATH;
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");
process.env.PATH = `${BIN_PATH}:${ORIGINAL_PATH ?? ""}`;
process.env.HERDR_TEST_LOG = HERDR_LOG;

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let A: typeof import("./attachments.ts");

function confirmStepLaunch(
  name: string,
  input: Omit<
    Parameters<typeof svc.workflowRuns.confirmStepLaunch>[1],
    "executionTarget"
  >,
  actorSessionId?: string | null,
) {
  return svc.workflowRuns.confirmStepLaunch(
    name,
    {
      ...input,
      executionTarget: {
        provider: "herdr",
        targetId: `p-${input.sessionId}`,
        context: "test-session",
      },
    },
    actorSessionId,
  );
}

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
// child, pinned to the reviewed head SHA. The engine reads the run's verdict from
// this review, not from any artifact.
function createWorkflowReview(input: {
  prIssueId: number;
  runId: number;
  sequence: number;
  event: "PASS" | "REQUEST_CHANGES";
  headSha: string;
  body: string;
  findings?: number;
}): number {
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
    S.createReviewComment(input.prIssueId, review.id, author, "agent", {
      path: `file-${i}.ts`,
      line: i + 1,
      body: "needs a fix",
    });
  }
  return review.id;
}

// The human who answers a cost hold acts from the Web, so their session is an ordinary browser id.
const HUMAN_SESSION = "5e55105e-5e55-4e55-8e55-5e555e555e55";

// The hold as a run really carries it: an over-limit observation, the event detection records for
// it, and the hold `cost-hold` establishes from that event. Returns the limit the hold sits on,
// which is what the release below has to name.
function holdOnCost(
  repoName: string,
  runId: number,
  usageSession: string,
  parentSessionId: string,
): number {
  const limitUsd = S.getWorkflowRun(runId)?.cost_limit_usd ?? 0;
  S.upsertSessionUsage(usageSession, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: limitUsd + 1,
  });
  svc.workflowRuns.detectCostExceeded(repoName, {
    run: runId,
    usageSession,
  });
  svc.workflowRuns.awaitHuman(
    repoName,
    { run: runId, reason: `Cost limit exceeded at $${limitUsd}` },
    parentSessionId,
  );
  return limitUsd;
}

// Raising the limit is the whole release: the human's decision to continue clears the hold in the
// same transaction, so no other operation follows it.
function releaseCostHold(repoName: string, runId: number, limitUsd: number) {
  return svc.workflowRuns.increaseCostLimitForHuman(
    repoName,
    { run: runId, expectedLimitUsd: limitUsd },
    HUMAN_SESSION,
  );
}

beforeAll(async () => {
  const herdr = join(BIN_PATH, "herdr");
  writeFileSync(
    herdr,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
`,
  );
  chmodSync(herdr, 0o755);

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
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.HERDR_TEST_LOG;
  rmSync(BIN_PATH, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
  rmSync(REPO_PATH, { recursive: true, force: true });
});

test.each([
  [
    "id",
    (workflow: { id: number; name: string }) => ({ workflowId: workflow.id }),
  ],
  [
    "name",
    (workflow: { id: number; name: string }) => ({ workflow: workflow.name }),
  ],
])("start rejects an archived workflow selected by %s", async (_label, input) => {
  const repo = S.createRepo(`me/archived-workflow-${_label}`, REPO_PATH);
  const workflow = svc.workflows.create({ name: `archived-${_label}` });
  svc.workflows.archive(workflow.name);

  await expect(
    svc.workflowRuns.start(repo.full_name, { issue: 1, ...input(workflow) }),
  ).rejects.toMatchObject({ status: 404, message: "Workflow not found" });
});

test("start rejects a workflow id scoped to another repository", async () => {
  const source = S.createRepo("me/scoped-workflow-source", REPO_PATH);
  const target = S.createRepo("me/scoped-workflow-target", REPO_PATH);
  const workflow = svc.workflows.create({
    name: "repository-only",
    repo: source.full_name,
  });

  await expect(
    svc.workflowRuns.start(target.full_name, {
      issue: 1,
      workflowId: workflow.id,
    }),
  ).rejects.toMatchObject({
    status: 422,
    message: "Workflow is not available for this repository",
  });
});

test("start by name uses the repository workflow over a same-name global workflow", async () => {
  const { repo } = freshRepo("me/overridden-workflow");
  svc.workflows.create({ name: "overridden" });
  const scoped = svc.workflows.create({
    name: "overridden",
    repo: repo.full_name,
  });
  const issue = S.createIssue(repo.id, "issue", "Override workflow", "", "me");

  const result = await svc.workflowRuns.start(
    repo.full_name,
    {
      issue: issue.number,
      workflow: "overridden",
    },
    "22222222-2222-4222-8222-222222222222",
  );

  expect(result.run.workflow_id).toBe(scoped.id);
}, 20_000);

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
  // #2354: the parent launch reads its prompt back from this file on its command line, so the
  // prompt is delivered by starting the agent rather than by a separate injection.
  expect(readFileSync(result.parent.user_prompt_path, "utf8")).toBe(
    result.parent.user_prompt,
  );

  // A hold blocks automatic progress. Releasing it is the human's own operation — raising the cost
  // limit, covered by its own tests below — so this one clears the row directly and carries on.
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
  S.updateWorkflowRun(result.run.id, { needsHumanReason: null });

  // launch returns pointers (repo/issue/pr), not synthesized input files, and records the
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
  // The step's prompt travels the same way: written to a file, read back by the typed command line.
  const stepPromptPath = /"\$\(cat '([^']+)'\)"/.exec(
    launched.herdr.command,
  )?.[1];
  expect(stepPromptPath).toBeTruthy();
  expect(readFileSync(stepPromptPath as string, "utf8")).toBe(
    launched.user_prompt,
  );
  expect(launched.herdr.argv.slice(3, 5)).toEqual(["pane", "send-text"]);
  expect(launched.agent_name).toBe(`executor #${result.run.id}-1`);

  const launchedAt = new Date(Date.now() - 10_000).toISOString();
  confirmStepLaunch(
    repo.full_name,
    {
      run: result.run.id,
      step: launched.step,
      sessionId: launched.session_id,
      agentName: launched.agent_name,
      pointers: launched.pointers,
      note: "Read the issue first.",
      model: launched.model,
      launchedAt,
    },
    result.session_id,
  );
  expect(
    JSON.parse(S.getWorkflowRun(result.run.id)!.step_sessions_json),
  ).toEqual({ execute: [launched.session_id] });
  expect(S.getAgentSession(launched.session_id)?.name).toBe(
    launched.agent_name,
  );
  expect(S.getAgentSession(launched.session_id)?.model).toBe("sonnet");
  expect(S.getAgentSession(launched.session_id)?.created_at).toBe(launchedAt);
  expect(
    S.listHandoffs(repo.id, {
      prId: S.getIssue(repo.id, result.pr.number)!.id,
    }),
  ).toEqual([
    expect.objectContaining({
      phase: "execute",
      direction: "down",
      body: [
        `Launch Workflow execute step for run ${result.run.id}.`,
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
  expect(result.parent.user_prompt).toContain("lh events subscribe");
  expect(result.parent.user_prompt).toContain(
    "wait for the next ping delivered to this pane",
  );
  expect(result.parent.user_prompt).not.toContain("launch-step");
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

  confirmStepLaunch(
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
  expect(readFileSync(started.parent.system_prompt_path, "utf8")).toContain(
    "`lh --help`",
  );
  const execute = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
    started.session_id,
  );
  expect(readFileSync(execute.system_prompt_path, "utf8")).toContain(
    "# Execute ステップ contract",
  );
  expect(readFileSync(execute.system_prompt_path, "utf8")).toContain(
    "`lh --help`",
  );
  expect(execute.user_prompt).toContain("## Step prompt（ユーザー設定）");
  expect(execute.user_prompt).toContain("(none - contract に従ってください)");
  // Starting the verifier is the run's move into Verify, so it needs something to review.
  commit(started.worktree, "impl.txt", "v1\n");
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    started.session_id,
  );
  expect(readFileSync(verify.system_prompt_path, "utf8")).toContain(
    "# Verify ステップ contract",
  );
  expect(readFileSync(verify.system_prompt_path, "utf8")).toContain(
    "`lh --help`",
  );
  expect(verify.pointers.at(-1)?.label).toBe(
    "review submission target (do not read the PR)",
  );

  confirmStepLaunch(
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
        `Workflow execute step を run ${started.run.id} 向けに起動します。`,
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

test("start creates the initial PR title and body in the configured language", async () => {
  const workflow = S.createWorkflow({
    name: "localized-pr",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const repoPaths: string[] = [];

  try {
    const { repo: japaneseRepo, path: japaneseRepoPath } = freshRepo(
      "me/workflow-pr-japanese",
    );
    repoPaths.push(japaneseRepoPath);
    const englishIssue = S.createIssue(
      japaneseRepo.id,
      "issue",
      "Add an English feature",
      "",
      "me",
    );
    svc.settings.update({ workflowContractLanguage: "ja" });
    const japaneseRun = await svc.workflowRuns.start(
      japaneseRepo.full_name,
      { issue: englishIssue.number, workflowId: workflow.id },
      "c7c7c7c7-c7c7-47c7-87c7-c7c7c7c7c7c7",
    );
    const japanesePr = await svc.pulls.get(
      japaneseRepo.full_name,
      japaneseRun.pr.number,
    );
    expect(japanesePr.title).toBe(`Issue #${englishIssue.number} を実装する`);
    expect(japanesePr.body).toBe(
      [
        "## Implementation plan",
        "",
        "<!-- Execute ステップはソース編集前にここを短い実装プランで更新してください。",
        "含める内容: 変更予定ファイル/領域、再利用する既存 API/component/module、スコープ境界、更新・実行するテスト。 -->",
        "",
        "## Evidence",
        "",
        "- **Visual evidence gate**: TODO - `UI / visual candidate: yes|no` を記録する。`yes` の場合はスクリーンショット、または具体的な `N/A` の理由を記載する。",
        "",
        `Closes #${englishIssue.number}`,
        "",
      ].join("\n"),
    );

    const { repo: englishRepo, path: englishRepoPath } = freshRepo(
      "me/workflow-pr-english",
    );
    repoPaths.push(englishRepoPath);
    const japaneseIssue = S.createIssue(
      englishRepo.id,
      "issue",
      "日本語の機能を追加する",
      "",
      "me",
    );
    svc.settings.update({ workflowContractLanguage: "en" });
    const englishRun = await svc.workflowRuns.start(
      englishRepo.full_name,
      { issue: japaneseIssue.number, workflowId: workflow.id },
      "d8d8d8d8-d8d8-48d8-88d8-d8d8d8d8d8d8",
    );
    const englishPr = await svc.pulls.get(
      englishRepo.full_name,
      englishRun.pr.number,
    );
    expect(englishPr.title).toBe(`Implement issue #${japaneseIssue.number}`);
    expect(englishPr.body).toBe(
      [
        "## Implementation plan",
        "",
        "<!-- Before editing source, briefly update this section with the implementation plan.",
        "Include: files/areas to change, existing APIs/components/modules to reuse, scope boundaries, and tests to update or run. -->",
        "",
        "## Evidence",
        "",
        "- **Visual evidence gate**: TODO - record `UI / visual candidate: yes|no`; for `yes`, include screenshot evidence or a specific `N/A` reason.",
        "",
        `Closes #${japaneseIssue.number}`,
        "",
      ].join("\n"),
    );
  } finally {
    svc.settings.update({ workflowContractLanguage: "en" });
    for (const path of repoPaths) {
      rmSync(path, { recursive: true, force: true });
    }
  }
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
  // Raising the limit is a human operation with no CLI entry point, so the actor is a Web session.
  const humanSessionId = "99999999-7777-4999-8999-999999999999";
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
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      humanSessionId,
    ),
  ).toThrow("Workflow run is not waiting for a human");
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run.id, reason: "Cost limit exceeded" },
    parentSessionId,
  );
  expect(() =>
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 1 },
      humanSessionId,
    ),
  ).toThrow("does not match current limit");
  expect(
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      humanSessionId,
    ),
  ).toEqual({
    run: run.id,
    increment_usd: 2.5,
    previous_limit_usd: 2.5,
    current_limit_usd: 5,
  });
  // Raising it again is refused, and now the hold is what refuses: releasing it was part of the
  // raise, so there is no second decision for the same crossing to make.
  expect(() =>
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      humanSessionId,
    ),
  ).toThrow("not waiting for a human");

  // The raise is the human's decision to continue, so it releases the hold in the same operation —
  // nothing else has to resume the run. Execute keeps working in the same pane rather than being
  // launched a second time (#1872): its active step and session survive the release.
  const released = S.getWorkflowRun(run.id);
  expect(released).toMatchObject({
    needs_human_reason: null,
    active_step: "execute",
    active_session_id: childSessionId,
    cost_limit_usd: 5,
  });
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
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 5 },
      humanSessionId,
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
  S.updateWorkflowRun(heldWithoutEvent.id, {
    activeStep: "execute",
    activeSessionId: childSessionId,
  });
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: heldWithoutEvent.id, reason: "Ordinary human hold" },
    parentSessionId,
  );
  // A hold with no over-limit observation behind it is not one a raise answers, so the refusal
  // leaves both the limit and the hold exactly as they were.
  expect(() =>
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: heldWithoutEvent.id, expectedLimitUsd: 2.5 },
      humanSessionId,
    ),
  ).toThrow("no cost exceeded event exists");
  expect(S.getWorkflowRun(heldWithoutEvent.id)).toMatchObject({
    needs_human_reason: "Ordinary human hold",
    cost_increment_usd: 2.5,
    cost_limit_usd: 2.5,
  });
});

test("cost exceeded is re-emitted until the run is held or its limit is raised (#1844)", async () => {
  const repo = S.createRepo("me/workflow-cost-reemit", REPO_PATH);
  const pull = S.createIssue(repo.id, "pull", "Re-emitting PR", "", "me");
  S.createPull(pull.id, "cost-reemit", "main", null);
  const workflow = S.createWorkflow({
    name: "cost-reemit-workflow",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parentSessionId = "18441844-1844-4184-8184-184418441844";
  const childSessionId = "18450000-1845-4184-8184-184518451845";
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
  const detect = () =>
    svc.workflowRuns.detectCostExceeded(repo.full_name, {
      run: run.id,
      usageSession: childSessionId,
    });
  const costEvents = () =>
    S.eventsForWorkflowRun(repo.id, run.id).filter(
      (event) => event.type === "workflow_run.cost_exceeded",
    );

  // A live parent reaches cost-hold well inside the interval, so the sweeps in between stay quiet.
  expect(detect()).toEqual({ emitted: true, cost_usd: 3, limit_usd: 2.5 });
  expect(detect()).toEqual({ emitted: false, cost_usd: 3, limit_usd: 2.5 });
  expect(costEvents()).toHaveLength(1);

  // A parent that stopped between wake and cost-hold leaves the run unheld, so the next sweep past
  // the interval re-sends the interrupt.
  process.env.LOOPHUB_COST_REEMIT_MS = "0";
  try {
    expect(detect()).toEqual({ emitted: true, cost_usd: 3, limit_usd: 2.5 });
    expect(costEvents()).toHaveLength(2);
    expect(JSON.parse(costEvents()[1].payload)).toMatchObject({
      cost_usd: 3,
      limit_usd: 2.5,
      next_limit_usd: 5,
    });

    // Once a hold exists the event has been acted on. This only stops new emissions — the ones
    // already queued behind the parent's cursor are still delivered, and it is `cost.hold`'s
    // per-limit receipt that keeps them from replaying Esc and the pane notification (covered
    // end-to-end in cli/workflow-cost-hold.test.ts). A human answering "no" keeps the hold, so
    // this also covers that case.
    svc.workflowRuns.awaitHuman(
      repo.full_name,
      { run: run.id, reason: "Cost limit exceeded" },
      parentSessionId,
    );
    expect(detect()).toEqual({ emitted: false, cost_usd: 3, limit_usd: 2.5 });
    expect(costEvents()).toHaveLength(2);

    // After the increase the run is back under its limit and no longer held, so detection stops on
    // the cost condition.
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      "1846c0de-1846-4184-8184-184618461846",
    );
    expect(S.getWorkflowRun(run.id)?.needs_human_reason).toBeNull();
    expect(detect()).toEqual({ emitted: false, cost_usd: 3, limit_usd: 5 });
    expect(costEvents()).toHaveLength(2);
  } finally {
    delete process.env.LOOPHUB_COST_REEMIT_MS;
  }
});

test("a Web budget increase raises the limit and releases the hold (#1828)", async () => {
  const repo = S.createRepo("me/workflow-web-budget", REPO_PATH);
  const pull = S.createIssue(repo.id, "pull", "Web budget PR", "", "me");
  S.createPull(pull.id, "web-budget", "main", null);
  const parentSessionId = "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a";
  const childSessionId = "9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b";
  // The Web session is an ordinary browser id, not a registered agent session.
  const webSessionId = "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c";
  S.registerAgentSession(parentSessionId, "lh-workflow", parentSessionId);
  S.registerAgentSession(childSessionId, "workflow-step", childSessionId);
  const workflow = S.createWorkflow({
    name: "web-budget-workflow",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
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

  // A running, unheld run exposes its budget but offers no increase.
  expect(
    await svc.workflowRuns.stateForIssue(repo.full_name, {
      issue: pull.number,
    }),
  ).toMatchObject({
    cost_increment_usd: 2.5,
    cost_limit_usd: 2.5,
    cost_limit_increase_available: false,
  });
  expect(() =>
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      webSessionId,
    ),
  ).toThrow("not waiting for a human");

  svc.workflowRuns.detectCostExceeded(repo.full_name, {
    run: run.id,
    usageSession: childSessionId,
  });
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run.id, reason: "Cost limit exceeded" },
    parentSessionId,
  );
  expect(
    await svc.workflowRuns.stateForPull(repo.full_name, {
      pull: pull.number,
    }),
  ).toMatchObject({ cost_limit_increase_available: true });

  expect(
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      webSessionId,
    ),
  ).toEqual({
    run: run.id,
    increment_usd: 2.5,
    previous_limit_usd: 2.5,
    current_limit_usd: 5,
  });
  // The raise is itself the human's decision to continue, so the same operation clears the hold —
  // there is no second step for anyone to run. The interrupted Execute keeps its pane.
  expect(S.getWorkflowRun(run.id)).toMatchObject({
    needs_human_reason: null,
    active_step: "execute",
    active_session_id: childSessionId,
  });
  const releaseEvent = S.eventsForWorkflowRun(repo.id, run.id)
    .filter((event) => event.type === "workflow_run.updated")
    .at(-1);
  expect(JSON.parse(releaseEvent!.payload)).toMatchObject({
    transition: "resume_after_human",
    needs_human_reason: null,
  });
  // The new limit is visible and no longer increasable: the hold now has no matching event.
  expect(
    await svc.workflowRuns.stateForIssue(repo.full_name, {
      issue: pull.number,
    }),
  ).toMatchObject({
    cost_limit_usd: 5,
    cost_limit_increase_available: false,
  });

  const increased = S.eventsForWorkflowRun(repo.id, run.id).find(
    (event) => event.type === "workflow_run.cost_limit_increased",
  );
  // The event names the step the cost hold interrupted, which is the one that carries on.
  expect(JSON.parse(increased!.payload)).toMatchObject({
    id: run.id,
    active_step: "execute",
    previous_limit_usd: 2.5,
    current_limit_usd: 5,
  });
});

// `cost-hold` writes the hold before it resolves the child to interrupt, and keeps the hold when
// that resolution fails, so a held run with no active child is a state the product really produces.
// The raise is the only thing that lifts a hold, so it must not require one.
test("a hold taken with no active child is still released by a raise", async () => {
  const repo = S.createRepo("me/workflow-childless-hold", REPO_PATH);
  const pull = S.createIssue(repo.id, "pull", "Childless hold PR", "", "me");
  S.createPull(pull.id, "childless-hold", "main", null);
  const workflow = S.createWorkflow({
    name: "childless-hold-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parentSessionId = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
  const webSessionId = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
  S.registerAgentSession(parentSessionId, "lh-workflow", parentSessionId);
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
  // The parent's own usage counts toward the run, so the limit can be crossed with no child at all.
  S.upsertSessionUsage(parentSessionId, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 3,
  });
  svc.workflowRuns.detectCostExceeded(repo.full_name, {
    run: run.id,
    usageSession: parentSessionId,
  });
  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run.id, reason: "Cost limit exceeded" },
    parentSessionId,
  );
  expect(S.getWorkflowRun(run.id)?.active_step).toBeNull();

  // The Web offers the raise here too: a hold nothing can lift would leave closing the PR as the
  // only way out of the run.
  expect(
    await svc.workflowRuns.stateForPull(repo.full_name, { pull: pull.number }),
  ).toMatchObject({ cost_limit_increase_available: true });
  expect(
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run: run.id, expectedLimitUsd: 2.5 },
      webSessionId,
    ),
  ).toMatchObject({ previous_limit_usd: 2.5, current_limit_usd: 5 });
  expect(S.getWorkflowRun(run.id)).toMatchObject({
    needs_human_reason: null,
    active_step: null,
    active_session_id: null,
  });
});

// #1872: a cost hold's resume must continue the interrupted executor in the same pane. Clearing the
// active session left the run looking like "Execute not started", spawning a duplicate executor.
// Verify keeps the opposite rule — a fresh child reviews the current HEAD — so resuming Verify still
// clears it.
test("a released cost hold continues Execute but relaunches Verify (#1872)", async () => {
  const { repo } = freshRepo("me/workflow-resume-active");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Resume active",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "resume-active-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
    parent,
  );
  confirmStepLaunch(
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

  // A cost hold interrupts the executor mid-work (no turn done yet). The release preserves it.
  const executeLimit = holdOnCost(
    repo.full_name,
    started.run.id,
    exec.session_id,
    parent,
  );
  releaseCostHold(repo.full_name, started.run.id, executeLimit);
  expect(S.getWorkflowRun(started.run.id)).toMatchObject({
    needs_human_reason: null,
    active_step: "execute",
    active_session_id: exec.session_id,
  });

  // Take the run to Verify with HEAD ahead of base, hold again, then release at Verify: the
  // interrupted verifier is dropped and the parent launches a fresh one for the current HEAD.
  commit(started.worktree, "impl.txt", "v1\n");
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  confirmStepLaunch(
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
  expect(
    await svc.workflowRuns.stateForPull(repo.full_name, {
      pull: started.pr.number,
    }),
  ).toMatchObject({
    current_step: "verify",
    active_verify_head_sha: verify.head_sha,
  });
  const verifyLimit = holdOnCost(
    repo.full_name,
    started.run.id,
    verify.session_id,
    parent,
  );
  expect(
    (
      await svc.workflowRuns.stateForPull(repo.full_name, {
        pull: started.pr.number,
      })
    )?.active_verify_head_sha,
  ).toBeNull();
  releaseCostHold(repo.full_name, started.run.id, verifyLimit);
  expect(S.getWorkflowRun(started.run.id)).toMatchObject({
    needs_human_reason: null,
    active_step: null,
    active_session_id: null,
  });
}, 30_000);

// A re-verification of the same head is deliberate, but there still has to be a head to review:
// a worktree rewound to base leaves the verifier an empty diff.
test("a Verify launch is refused once HEAD is back at base", async () => {
  const { repo } = freshRepo("me/workflow-verify-empty");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Verify empty",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "verify-empty-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  commit(started.worktree, "impl.txt", "v1\n");
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  confirmStepLaunch(
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
  expect(S.getWorkflowRun(started.run.id)?.current_step).toBe("verify");

  gitAt(started.worktree, ["reset", "--hard", "main"]);
  await expect(
    svc.workflowRuns.launchStep(
      repo.full_name,
      { run: started.run.id, step: "verify" },
      parent,
    ),
  ).rejects.toThrowError(/head equals base/);
}, 30_000);

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

  confirmStepLaunch(
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

  const eventCountBeforeState = S.eventsForWorkflowRun(
    repo.id,
    started.run.id,
  ).length;
  const initial = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(initial).toMatchObject({
    current_step: "execute",
    active_step: null,
    active_session_id: null,
    turn_done_for_active_execute: false,
    awaiting_human: false,
  });
  expect(initial.steps.execute.complete).toBe(false);
  // Observation is a read: it records nothing and repeats itself.
  expect(
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id }),
  ).toEqual(initial);
  expect(S.eventsForWorkflowRun(repo.id, started.run.id)).toHaveLength(
    eventCountBeforeState,
  );

  // An Execute child's request for human judgement is not a state field: it stays an event the
  // parent reads for its wording.
  const escalated = S.emitEvent(repo.id, "workflow_run.escalated", "executor", {
    id: started.run.id,
    reason: "Need product guidance",
  });
  expect(JSON.parse(escalated.payload)).toMatchObject({
    id: started.run.id,
    reason: "Need product guidance",
  });

  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: started.run.id, reason: "Waiting for product guidance" },
    parent,
  );
  expect(
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id }),
  ).toMatchObject({
    awaiting_human: true,
    needs_human_reason: "Waiting for product guidance",
  });
  // The hold's own release is the human's raise, covered by the cost-limit tests; the rest of this
  // one is about what the state reports, so it clears the row and moves on.
  S.updateWorkflowRun(started.run.id, { needsHumanReason: null });
  expect(
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ needs_human_reason: null });
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
  confirmStepLaunch(
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
  // Execute is not complete and the move into Verify — the Verify launch itself — is refused.
  const before = await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  expect(before.event_id).toBeGreaterThan(0);
  let status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.last_turn_done_at).not.toBeNull();
  expect(status.turn_done_for_active_execute).toBe(true);
  expect(status.head_ahead_of_base).toBe(false);
  expect(status.steps.execute.complete).toBe(false);
  await expect(
    svc.workflowRuns.launchStep(
      repo.full_name,
      { run: started.run.id, step: "verify" },
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
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ turn_done_for_active_execute: false });
  // `turnDone` reads the worktree HEAD before it records the declaration, so the event only exists
  // once the call settles. Observing without awaiting it left the assertion below racing the emit.
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  expect(
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id }),
  ).toMatchObject({
    turn_done_for_active_execute: true,
    head_ahead_of_base: false,
  });

  // The operator can deliver another follow-up without an automatic hold. Progress in that round
  // allows the normal Execute-to-Verify transition.
  svc.workflowRuns.activateStep(
    repo.full_name,
    {
      run: started.run.id,
      step: "execute",
      sessionId: exec.session_id,
    },
    parent,
  );
  const headA = commit(started.worktree, "impl.txt", "done\n");
  expect(
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ turn_done_for_active_execute: false });

  // Execute declares the new turn done. Now HEAD is ahead of base.
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.head_ahead_of_base).toBe(true);
  expect(status.steps.execute.complete).toBe(true);

  // Verify submits a passing review pinned to the reviewed head. Launching it is also what records
  // the run's move into the Verify phase.
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  confirmStepLaunch(
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
      headSha: headA,
      body: "All criteria pass.",
    },
    verify.session_id,
  );

  // Regression for run 82: registering the fresh review itself gives the parent its observation
  // trigger. Verify does not need a later turn-done declaration, and the event carries only
  // pointers — the persisted review remains the verdict source.
  const reviewEvent = S.listEvents(0, repo.id, 100).findLast(
    (event) => event.type === "pull_request.review_submitted",
  );
  expect(reviewEvent).toBeDefined();
  expect(JSON.parse(reviewEvent!.payload)).toEqual({
    number: started.pr.number,
    state: "PASS",
    comments: 0,
    session_id: verify.session_id,
    review_id: passReview.id,
    submission_head_sha: headA,
    source_payload_version: 1,
  });

  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.complete).toBe(true);
  expect(status.steps.verify.latest_review).toMatchObject({
    id: passReview.id,
    event: "pass",
    fresh: true,
    headSha: headA,
  });
  expect(status.done).toBe(true);

  // Done follows the PR-wide gate, not only this run's Verify result. A later human review blocks
  // merge readiness even though the run-owned Verify observation remains fresh and complete.
  S.createReview(
    prIssueId,
    "human-reviewer",
    "REQUEST_CHANGES",
    "The PR-wide gate is blocked.",
    headA,
  );
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.complete).toBe(true);
  expect(status.done).toBe(false);

  // A second pass from this run's verifier is the run's own work, not out-of-band review input,
  // however many submissions the PR has collected.
  const newerPassReview = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    {
      event: "PASS",
      headSha: headA,
      body: "The same head still passes.",
    },
    verify.session_id,
  );
  const newerReviewEvent = S.listEvents(0, repo.id, 100).findLast(
    (event) =>
      event.type === "pull_request.review_submitted" &&
      JSON.parse(event.payload).review_id === newerPassReview.id,
  );
  expect(newerReviewEvent).toBeDefined();
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.latest_review).toMatchObject({
    id: newerPassReview.id,
    event: "pass",
    fresh: true,
  });
  expect(
    status.unaddressed_out_of_band_reviews.map((review) => review.id),
  ).not.toContain(newerPassReview.id);

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
  // remains at Verify, and the work goes to the Execute child that is still live: launching a
  // second executor into the same worktree is refused rather than silently recorded (#2150).
  await expect(
    svc.workflowRuns.launchStep(
      repo.full_name,
      {
        run: started.run.id,
        step: "execute",
        note: "Add another requested change.",
      },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });

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
  let continuing = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(continuing.pr_closed).toBe(false);
  expect(continuing.done).toBe(true);
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
    exec.session_id,
  );
  const staleStatus = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(staleStatus.head_sha).toBe(headB);
  expect(staleStatus.done).toBe(false);
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
  continuing = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(continuing.pr_closed).toBe(false);
  expect(continuing.done).toBe(true);
  expect(continuing.steps.verify.latest_review).toMatchObject({
    event: "pass",
    fresh: true,
    headSha: headB,
  });
}, 30_000);

// #1844: detection re-emits while a parent is away, and the (run, limit) receipt — not the wake —
// is what keeps the hold's effects one-time.
test("a completed cost-hold receipt keeps a re-emitted cost event from holding twice", async () => {
  const { repo } = freshRepo("me/workflow-cost-hold-action");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Cost",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "cost-hold-action-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  // The event names the run's own cumulative limit: that is what `cost-hold` resolves from the run
  // row, and what its receipt is scoped to.
  const limitUsd = S.getWorkflowRun(started.run.id)?.cost_limit_usd ?? 0;
  const costPayload = {
    id: started.run.id,
    active_step: "execute" as const,
    active_session_id: null,
    cost_usd: limitUsd + 2,
    limit_usd: limitUsd,
  };
  const first = S.emitEvent(
    repo.id,
    "workflow_run.cost_exceeded",
    "lh-worker",
    costPayload,
  );

  svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: started.run.id, reason: "Cost limit exceeded" },
    parent,
  );
  S.beginWorkflowEventEffect(started.run.id, first.id, "cost.hold");
  S.completeWorkflowEventEffect(started.run.id, first.id, "cost.hold");
  S.emitEvent(repo.id, "workflow_run.cost_exceeded", "lh-worker", costPayload);

  await expect(
    svc.workflowCostHold.run(repo.full_name, { run: started.run.id }, parent),
  ).resolves.toMatchObject({ status: "already_completed", completed: [] });
}, 20_000);

// #1808: the merged PR is the run's terminal condition. Before this, a parent kept reconciling a
// run whose PR had shipped and only stopped once its cost limit was exceeded (run #306).
test("a merged PR completes the run and ends cost detection", async () => {
  const { repo } = freshRepo("me/workflow-merge-terminal");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Merge terminal",
    "## Acceptance criteria\n- [ ] Ships\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "merge-terminal-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const run = started.run.id;
  const child = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
  S.registerAgentSession(child, "workflow-step", child);
  S.appendWorkflowRunStepSession(run, "execute", child);
  commit(started.worktree, "impl.txt", "shipped\n");

  // An open PR still reconciles toward the goal, so a fresh pass alone leaves the run running.
  createWorkflowReview({
    prIssueId: S.getIssue(repo.id, started.pr.number)!.id,
    runId: run,
    sequence: 1,
    event: "PASS",
    headSha: gitAt(started.worktree, ["rev-parse", "HEAD"]),
    body: "Looks good",
  });
  expect(await svc.workflowRuns.state(repo.full_name, { run })).toMatchObject({
    pr_merged: false,
    pr_closed: false,
    done: true,
  });
  expect(S.getWorkflowRun(run)?.status).toBe("running");

  // The merge source itself is the run's wake; no run-scoped projection is needed.
  await svc.pulls.merge(repo.full_name, started.pr.number, "merge");
  const source = S.listEvents(0, repo.id, 1_000).findLast(
    (event) =>
      event.type === "pull_request.merged" &&
      JSON.parse(event.payload).number === started.pr.number,
  )!;
  expect(JSON.parse(source.payload)).toMatchObject({
    number: started.pr.number,
    source_payload_version: 1,
  });
  // Merge closes the PR, and the run reads that from the merge source itself — no run-scoped
  // close twin is written for it any more.
  expect(
    S.eventsForWorkflowRun(repo.id, run).filter(
      (event) => event.type === "workflow_run.closed",
    ),
  ).toEqual([]);
  expect(await svc.workflowRuns.state(repo.full_name, { run })).toMatchObject({
    pr_merged: true,
    pr_closed: true,
  });
  // The PR carries the end; nothing records it a second time on the run row.
  expect(S.getWorkflowRun(run)?.status).toBe("running");

  // No further cost-exceeded edge can fire for a run that has ended.
  S.upsertSessionUsage(child, {
    model: "test",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 999,
  });
  expect(
    svc.workflowRuns.detectCostExceeded(repo.full_name, {
      run,
      usageSession: child,
    }).emitted,
  ).toBe(false);
  expect(
    S.eventsForWorkflowRun(repo.id, run).filter(
      (event) => event.type === "workflow_run.cost_exceeded",
    ),
  ).toHaveLength(0);
}, 20_000);

// The terminal condition is the PR's own domain state, so a merge recorded by any route — not just
// `pulls.merge` — reconciles to the same completion.
test("any merge route that leaves the PR merged completes the run", async () => {
  const { repo } = freshRepo("me/workflow-merge-route");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Merge route",
    "## Acceptance criteria\n- [ ] Ships\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "merge-route-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const run = started.run.id;
  commit(started.worktree, "impl.txt", "shipped\n");
  S.setMerged(S.getIssue(repo.id, started.pr.number)!.id, "deadbeef", "squash");

  expect(await svc.workflowRuns.state(repo.full_name, { run })).toMatchObject({
    pr_merged: true,
    pr_closed: true,
  });
}, 20_000);

test("closing an unmerged PR completes the run", async () => {
  const { repo } = freshRepo("me/workflow-close-route");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Close route",
    "## Acceptance criteria\n- [ ] Stops when closed\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "close-route-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const run = started.run.id;

  svc.pulls.update(repo.full_name, started.pr.number, { state: "closed" });

  const source = S.listEvents(0, repo.id, 1_000).findLast(
    (event) =>
      event.type === "pull_request.updated" &&
      JSON.parse(event.payload).number === started.pr.number,
  )!;
  expect(await svc.workflowRuns.state(repo.full_name, { run })).toMatchObject({
    pr_merged: false,
    pr_closed: true,
  });
  expect(S.getWorkflowRun(run)?.status).toBe("running");

  expect(
    S.eventsForWorkflowRun(repo.id, run).filter(
      (event) => event.type === "workflow_run.closed",
    ),
  ).toEqual([]);
  expect(JSON.parse(source.payload)).toMatchObject({
    number: started.pr.number,
    source_payload_version: 1,
  });
}, 20_000);

test("closing a PR through issues.update completes the run", async () => {
  const { repo } = freshRepo("me/workflow-issue-update-close");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Issue update close",
    "## Acceptance criteria\n- [ ] Stops when closed\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "issue-update-close-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const started = await svc.workflowRuns.start(repo.full_name, {
    issue: issue.number,
    workflowId: workflow.id,
  });
  const run = started.run.id;

  svc.issues.update(repo.full_name, started.pr.number, { state: "closed" });

  const source = S.listEvents(0, repo.id, 1_000).findLast(
    (event) =>
      event.type === "pull_request.updated" &&
      JSON.parse(event.payload).number === started.pr.number,
  )!;
  expect(source.type).toBe("pull_request.updated");
  expect(await svc.workflowRuns.state(repo.full_name, { run })).toMatchObject({
    pr_closed: true,
  });
}, 20_000);

// The run row records no end, so every lifecycle operation asks the PR instead. Without this a
// merged PR's worktree would still accept a fresh child, and a cost hold on it would stay
// actionable — both are steps toward a goal the merge already settled.
test("an ended run refuses lifecycle progress and withholds the cost-limit increase", async () => {
  const { repo } = freshRepo("me/workflow-ended-guards");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Ended guards",
    "## Acceptance criteria\n- [ ] Ships\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "ended-guards-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const run = started.run.id;
  commit(started.worktree, "impl.txt", "shipped\n");
  const child = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
  S.registerAgentSession(child, "workflow-step", child);
  S.appendWorkflowRunStepSession(run, "execute", child);
  S.updateWorkflowRun(run, {
    activeStep: "execute",
    activeSessionId: child,
    needsHumanReason: "Cost limit exceeded; human decision required",
  });
  const limitUsd = S.getWorkflowRun(run)!.cost_limit_usd as number;
  const incrementUsd = S.getWorkflowRun(run)!.cost_increment_usd as number;
  S.emitWorkflowRunCostExceeded(
    repo.id,
    "test",
    {
      id: run,
      number: issue.number,
      pr_number: started.pr.number,
      parent_session_id: parent,
      session_id: parent,
      usage_session_id: child,
      active_step: "execute",
      active_session_id: child,
      cost_usd: limitUsd + 2.5,
      limit_usd: limitUsd,
      increment_usd: incrementUsd,
      next_limit_usd: limitUsd + incrementUsd,
    },
    0,
  );
  const held = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: started.pr.number,
  });
  expect(held?.cost_limit_increase_available).toBe(true);

  await svc.pulls.merge(repo.full_name, started.pr.number, "merge");

  const ended = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: started.pr.number,
  });
  expect(ended).toMatchObject({
    pr_merged: true,
    cost_limit_increase_available: false,
    active_verify_head_sha: null,
  });
  expect(() =>
    svc.workflowRuns.awaitHuman(
      repo.full_name,
      { run, reason: "still deciding" },
      parent,
    ),
  ).toThrowError(/has ended/);
  await expect(
    svc.workflowRuns.launchStep(
      repo.full_name,
      { run, step: "execute" },
      parent,
    ),
  ).rejects.toThrowError(/has ended/);
  expect(() =>
    svc.workflowRuns.increaseCostLimitForHuman(
      repo.full_name,
      { run, expectedLimitUsd: limitUsd },
      parent,
    ),
  ).toThrowError(/has ended/);
}, 20_000);

test("state exposes hold, rework, pending effects, and unaddressed out-of-band reviews", async () => {
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
  confirmStepLaunch(
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

  let status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status).toMatchObject({
    awaiting_human: false,
    needs_human_reason: null,
    rework_count: 0,
    rework_limit: 8,
    pending_effect_receipt: null,
    unaddressed_out_of_band_reviews: [],
  });

  const runEvent = S.eventsForWorkflowRun(repo.id, started.run.id).find(
    (event) => event.type.startsWith("workflow_run."),
  )!;
  S.beginWorkflowEventEffect(started.run.id, runEvent.id, "notify-observer");
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.pending_effect_receipt).toMatchObject({
    event_id: runEvent.id,
    effect: "notify-observer",
    status: "pending",
  });

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

  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.pending_effect_receipt).toBeNull();
  expect(status.unaddressed_out_of_band_reviews).toEqual([
    { id: feedback.id, verdict: "feedback" },
    { id: requestedChanges.id, verdict: "request_changes" },
  ]);
  const feedbackEvent = S.listEvents(0, repo.id, 500).find(
    (event) =>
      event.type === "pull_request.review_submitted" &&
      (JSON.parse(event.payload) as { review_id?: unknown }).review_id ===
        feedback.id,
  );
  expect(feedbackEvent).toBeDefined();

  // A turn done with the same HEAD observed at review submission does not address feedback pinned
  // to an older SHA: the progress must happen after the submission boundary.
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.unaddressed_out_of_band_reviews).toHaveLength(2);

  commit(started.worktree, "feedback.txt", "addressed\n");
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.unaddressed_out_of_band_reviews).toHaveLength(2);
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  status = await svc.workflowRuns.state(repo.full_name, {
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
  status = await svc.workflowRuns.state(repo.full_name, {
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
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.unaddressed_out_of_band_reviews).toEqual([]);

  S.updateWorkflowRun(started.run.id, {
    needsHumanReason: "waiting for guidance",
    reworkCount: 2,
  });
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status).toMatchObject({
    awaiting_human: true,
    needs_human_reason: "waiting for guidance",
    rework_count: 2,
    rework_limit: 8,
  });
}, 30_000);

test("an unattributed review counts as Verify's only while the run is verifying (#1849)", async () => {
  const { repo } = freshRepo("me/workflow-unknown-author");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Unknown author",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "unknown-author-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const prIssueId = S.getIssue(repo.id, started.pr.number)!.id;
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
    parent,
  );
  confirmStepLaunch(
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

  // An unregistered session posts as `unknown`. While Execute is running it is somebody else's
  // review, so it stays out-of-band work rather than becoming this run's Verify verdict.
  const baseHead = gitAt(started.worktree, ["rev-parse", "HEAD"]);
  const duringExecute = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    {
      event: "REQUEST_CHANGES",
      headSha: baseHead,
      body: "Drive-by review while Execute runs.",
    },
    "unregistered-observer",
  );
  expect(S.listReviews(prIssueId).at(-1)?.author).toBe("unknown");
  let status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.latest_review).toBeNull();
  expect(status.unaddressed_out_of_band_reviews).toEqual([
    { id: duringExecute.id, verdict: "request_changes" },
  ]);

  const headA = commit(started.worktree, "impl.txt", "done\n");
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  confirmStepLaunch(
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

  // The Verify child submits without a registered session id, so its author is `unknown` too. The
  // run-scoped submission event recorded while Verify is running makes it this run's verdict.
  const pass = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    {
      event: "PASS",
      headSha: headA,
      body: "All criteria pass.",
    },
    "unregistered-verifier",
  );
  expect(S.listReviews(prIssueId).at(-1)?.author).toBe("unknown");
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.complete).toBe(true);
  expect(status.steps.verify.latest_review).toMatchObject({
    id: pass.id,
    event: "pass",
    fresh: true,
    headSha: headA,
  });
  // The same review must not also be counted as work Execute still owes.
  expect(status.unaddressed_out_of_band_reviews).toEqual([]);

  // Another run's verifier keeps being ignored, and a registered human reviewer keeps being
  // out-of-band: neither replaces this run's pass.
  createWorkflowReview({
    prIssueId,
    runId: started.run.id + 1000,
    sequence: 1,
    event: "REQUEST_CHANGES",
    headSha: headA,
    body: "Another run's verifier.",
  });
  S.registerAgentSession(
    "human-reviewer-session",
    "me",
    "human-reviewer-session",
    "human-reviewer",
    "claude-code",
    "dev",
  );
  const humanReview = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    {
      event: "REQUEST_CHANGES",
      headSha: headA,
      body: "Please fix this too.",
    },
    "human-reviewer-session",
  );
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.complete).toBe(true);
  expect(status.steps.verify.latest_review).toMatchObject({
    id: pass.id,
    event: "pass",
  });
  expect(status.unaddressed_out_of_band_reviews).toEqual([
    { id: humanReview.id, verdict: "request_changes" },
  ]);
}, 30_000);

test("a verifying run keeps attributing its own Verify pass across cost-hold resumes and Execute reactivation (#1873)", async () => {
  const { repo } = freshRepo("me/workflow-verify-frozen");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Verify freeze",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "verify-frozen-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );

  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
    parent,
  );
  confirmStepLaunch(
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
  const verifyA = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      sessionId: verifyA.session_id,
      agentName: verifyA.agent_name,
      pointers: verifyA.pointers,
      headSha: verifyA.head_sha,
    },
    parent,
  );

  // The Verify child submits from a session LoopHub never registered (a child resumed in-pane after a
  // cost hold never re-runs launch / confirm), so its author is `unknown`. The run must still take
  // it as its own verdict because it was submitted in the Verify phase.
  const passA = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    { event: "PASS", headSha: headA, body: "v1 passes." },
    "unregistered-verify-a",
  );
  let status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.complete).toBe(true);
  expect(status.steps.verify.latest_review).toMatchObject({
    id: passA.id,
    event: "pass",
    fresh: true,
    headSha: headA,
  });

  // Cost-hold resume path A: the parent reactivates the Execute pane for live input while the run stays
  // in its Verify phase (active_step=execute, current_step=verify). Execute then commits again. Before
  // #1873 the active_step reading mis-classified the run as executing and froze latest_review at passA.
  svc.workflowRuns.activateStep(
    repo.full_name,
    { run: started.run.id, step: "execute", sessionId: exec.session_id },
    parent,
  );
  const headB = commit(started.worktree, "impl.txt", "v2\n");
  const passB = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    { event: "PASS", headSha: headB, body: "v2 passes." },
    "unregistered-verify-b",
  );
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.complete).toBe(true);
  expect(status.steps.verify.latest_review).toMatchObject({
    id: passB.id,
    event: "pass",
    fresh: true,
    headSha: headB,
  });

  // Cost-hold release path B: hold the run, let the human's raise release it, commit again, then
  // start another verifier. Before #1873 the phase move was not read as entering the Verify phase,
  // so a pass submitted right after it was dropped as out-of-band.
  const limitUsd = holdOnCost(
    repo.full_name,
    started.run.id,
    exec.session_id,
    parent,
  );
  releaseCostHold(repo.full_name, started.run.id, limitUsd);
  const headC = commit(started.worktree, "impl.txt", "v3\n");
  const verifyC = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  confirmStepLaunch(
    repo.full_name,
    {
      run: started.run.id,
      step: "verify",
      sessionId: verifyC.session_id,
      agentName: verifyC.agent_name,
      pointers: verifyC.pointers,
      headSha: verifyC.head_sha,
    },
    parent,
  );
  const passC = await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    { event: "PASS", headSha: headC, body: "v3 passes." },
    "unregistered-verify-c",
  );
  status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.steps.verify.complete).toBe(true);
  expect(status.steps.verify.latest_review).toMatchObject({
    id: passC.id,
    event: "pass",
    fresh: true,
    headSha: headC,
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
  confirmStepLaunch(
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

  // Verify requests changes, pinned to headA, with one finding.
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  confirmStepLaunch(
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
      headSha: headA,
      body: "One change required.",
      comments: [{ path: "file-0.ts", line: 1, body: "needs a fix" }],
    },
    verify.session_id,
  );
  const rcStatus = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(rcStatus.steps.verify.latest_review).toMatchObject({
    event: "request_changes",
    fresh: true,
  });
  const reviewId = rcStatus.steps.verify.latest_review!.id;

  // A review that is not the one Verify just submitted is refused rather than counted — asserted
  // while the run is still at Verify, so the refusal is the review-id check and not the phase one.
  await expect(
    svc.workflowRuns.rework(
      repo.full_name,
      { run: started.run.id, review: reviewId + 1 },
      parent,
    ),
  ).rejects.toThrowError(/is not the run's latest Verify review/);
  expect(S.getWorkflowRun(started.run.id)?.rework_count).toBe(0);

  const rework = await svc.workflowRuns.rework(
    repo.full_name,
    { run: started.run.id, review: reviewId },
    parent,
  );
  expect(rework.run).toMatchObject({
    current_step: "execute",
    rework_count: 1,
  });
  // One operation: the count, the phase and the fixed review pointer delivered to the pane.
  expect(rework.delivered).toMatchObject({
    session_id: exec.session_id,
    text: `orchestrator: address review ${reviewId}`,
  });
  expect(readFileSync(HERDR_LOG, "utf8")).toContain(
    `orchestrator: address review ${reviewId}`,
  );
  // The rework goes to the Execute child that is still live in its pane, so the same update hands
  // `active_step` back to that session (#2150).
  expect(S.getWorkflowRun(started.run.id)).toMatchObject({
    active_step: "execute",
    active_session_id: exec.session_id,
  });
  // Launching another Execute on top of that live child is refused instead of silently starting a
  // second executor in the same worktree.
  await expect(
    svc.workflowRuns.launchStep(
      repo.full_name,
      { run: started.run.id, step: "execute", review: reviewId },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });
  // The parent may observe between the phase move and the delivery to the pane. That intermediate
  // state must not read as "Execute has not started".
  const reworkEvent = S.eventsForWorkflowRun(repo.id, started.run.id).findLast(
    (event) =>
      event.type === "workflow_run.updated" &&
      (JSON.parse(event.payload) as Record<string, unknown>).transition ===
        "request_rework",
  );
  expect(reworkEvent).toBeDefined();
  expect(
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id }),
  ).toMatchObject({
    current_step: "execute",
    active_step: "execute",
    active_session_id: exec.session_id,
  });

  // Execute pushes a fix (HEAD advances past the request_changes review), declares turn done, and
  // the run advances to a fresh Verify.
  const headB = commit(started.worktree, "fix.txt", "v2\n");
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  const reworkedStatus = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  // The stale request_changes review no longer blocks execute (head advanced past it).
  expect(reworkedStatus.steps.execute.complete).toBe(true);
  createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 2,
    event: "PASS",
    headSha: headB,
    body: "Fixed.",
  });
  // The fresh pass verifies the reworked HEAD without terminating the run: the PR stays open and
  // the parent keeps observing (#1513 — no run-complete path).
  const reworked = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(reworked.pr_closed).toBe(false);
  expect(reworked.steps.verify.latest_review).toMatchObject({
    event: "pass",
    fresh: true,
    headSha: headB,
  });
}, 30_000);

// Run 340: a human injected follow-up work straight into the Execute pane, so `active_step` was
// never moved off `verify`. The idle verifier that already reviewed the old HEAD must not make the
// run wait forever (#1857).
test("a turn done after the active Verify reviewed launches a fresh Verify", async () => {
  const { repo } = freshRepo("me/workflow-stale-verify");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Stale Verify",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "stale-verify-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
    parent,
  );
  confirmStepLaunch(
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
  const verify = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "verify" },
    parent,
  );
  confirmStepLaunch(
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

  // The verifier launched for this turn done has not reported yet, so waiting is still right.
  expect(
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id }),
  ).toMatchObject({
    turn_done_for_active_execute: true,
    verify_launched_after_turn_done: true,
  });

  await svc.reviews.create(
    repo.full_name,
    started.pr.number,
    {
      event: "PASS",
      headSha: headA,
      body: "All criteria pass.",
    },
    verify.session_id,
  );

  // The Execute child keeps working from pane input and declares another turn done. `active_step`
  // still reads `verify`, but that verifier is idle behind the new HEAD.
  const headB = commit(started.worktree, "more.txt", "v2\n");
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );
  const status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status).toMatchObject({
    current_step: "verify",
    active_step: "verify",
    head_sha: headB,
    turn_done_for_active_execute: true,
    verify_launched_after_turn_done: false,
  });
  expect(status.steps.verify.latest_review).toMatchObject({ fresh: false });
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

test("intent-based run lifecycle rejects invalid transitions and caps rework at 8", async () => {
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

  // The lifecycle verbs the parent used to reach for are gone: a launch records the phase, a rework
  // carries its own delivery, and the human's hold is released by their own Web operation.
  for (const retired of [
    "update",
    "completeRun",
    "advanceToVerify",
    "requestRework",
    "resumeAfterHuman",
    "increaseCostLimit",
  ]) {
    expect(retired in svc.workflowRuns).toBe(false);
  }
  // Nothing committed yet: moving into Verify — the Verify launch itself — is illegal (Execute is
  // incomplete).
  await expect(
    svc.workflowRuns.launchStep(
      repo.full_name,
      { run: started.run.id, step: "verify" },
      parent,
    ),
  ).rejects.toMatchObject({ status: 409 });

  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
    parent,
  );
  confirmStepLaunch(
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
  let head = commit(started.worktree, "lifecycle.txt", "implemented\n");
  const launchVerify = async () => {
    const verify = await svc.workflowRuns.launchStep(
      repo.full_name,
      { run: started.run.id, step: "verify" },
      parent,
    );
    confirmStepLaunch(
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
  };
  await launchVerify();

  // Drive the rework budget to its cap. Each request_changes review is pinned to the current head,
  // and each rework advances the head so the next review is fresh again.
  for (let seq = 1; seq <= 8; seq++) {
    const reviewId = createWorkflowReview({
      prIssueId,
      runId: started.run.id,
      sequence: seq,
      event: "REQUEST_CHANGES",
      headSha: head,
      body: `Change ${seq}`,
      findings: 1,
    });
    const rework = await svc.workflowRuns.rework(
      repo.full_name,
      { run: started.run.id, review: reviewId },
      parent,
    );
    expect(rework.run.rework_count).toBe(seq);
    head = commit(started.worktree, `fix-${seq}.txt`, `v${seq}\n`);
    await launchVerify();
  }

  // The 9th request_changes exceeds the cap, and the refusal is the whole operation: no rework is
  // counted and nothing is delivered.
  const overLimitReview = createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 9,
    event: "REQUEST_CHANGES",
    headSha: head,
    body: "Change 9",
    findings: 1,
  });
  await expect(
    svc.workflowRuns.rework(
      repo.full_name,
      { run: started.run.id, review: overLimitReview },
      parent,
    ),
  ).rejects.toThrowError(/rework limit/);
  expect(S.getWorkflowRun(started.run.id)?.rework_count).toBe(8);

  // A fresh pass verifies the current HEAD without terminating the run (#1513): it stays `running`.
  // There is no run-stop transition anymore (#1525).
  createWorkflowReview({
    prIssueId,
    runId: started.run.id,
    sequence: 10,
    event: "PASS",
    headSha: head,
    body: "All criteria pass.",
  });
  const passed = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(passed.pr_closed).toBe(false);
  expect(passed.steps.verify.latest_review).toMatchObject({
    event: "pass",
    fresh: true,
    headSha: head,
  });
  expect("stopRun" in svc.workflowRuns).toBe(false);

  // Every run-row transition the cap run produced: one rework each round, and the reactivation its
  // delivery performs on the Execute pane it hands the review to.
  expect(lifecycleTransitions()).toEqual(
    Array.from({ length: 8 }, () => ["request_rework", "activate_step"]).flat(),
  );
}, 40_000);

test("stateForIssue / stateForPull expose run display state, or null when absent (#1008)", async () => {
  const repo = S.createRepo("me/workflow-state", REPO_PATH);
  const issue = S.createIssue(repo.id, "issue", "Show run state", "body", "me");
  const prIssue = S.createIssue(repo.id, "pull", "PR for state", "body", "me");
  git(["checkout", "-q", "main"]);
  git(["checkout", "-q", "-b", "state-head"]);
  const reviewedHead = commit(REPO_PATH, "state.txt", "reviewed\n");
  git(["checkout", "-q", "main"]);
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
    current_step: "verify",
    rework_count: 2,
    rework_limit: 8,
    issue_number: issue.number,
    pr_number: prIssue.number,
  });
  expect(byIssue?.latest_review).toMatchObject({
    event: "request_changes",
    summary: "Two acceptance criteria are unmet.",
    findings_count: 2,
  });
  expect(byIssue?.verification_status).toBe("unverified");
  expect(byIssue?.done).toBe(false);

  const byPull = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(byPull?.id).toBe(run.id);
  expect(byPull?.needs_human_reason).toBeNull();

  S.createReview(
    prIssue.id,
    "human-reviewer",
    "PASS",
    "The pull request is ready to merge.",
    reviewedHead,
  );
  const humanApproved = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(humanApproved?.verification_status).toBe("unverified");
  expect(humanApproved?.done).toBe(true);

  createWorkflowReview({
    prIssueId: prIssue.id,
    runId: run.id,
    sequence: 2,
    event: "PASS",
    headSha: reviewedHead,
    body: "Current HEAD passes.",
  });
  const verified = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(verified?.verification_status).toBe("verified");
  expect(verified?.done).toBe(true);
  expect(verified?.merge_conflict).toBe(false);
  S.createReview(
    prIssue.id,
    "human-reviewer",
    "REQUEST_CHANGES",
    "The PR-wide gate is blocked.",
    reviewedHead,
  );
  const blocked = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(blocked?.verification_status).toBe("verified");
  expect(blocked?.done).toBe(false);
  git(["checkout", "-q", "state-head"]);
  const advancedHead = commit(REPO_PATH, "state-next.txt", "changed\n");
  git(["checkout", "-q", "main"]);
  S.setHeadSha(prIssue.id, advancedHead);
  const stale = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(stale?.verification_status).toBe("stale");
  expect(stale?.done).toBe(false);

  S.updateWorkflowRun(run.id, { needsHumanReason: "waiting for guidance" });
  const waiting = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(waiting?.needs_human_reason).toBe("waiting for guidance");

  S.updateIssue(prIssue.id, { state: "closed" });
  const closed = await svc.workflowRuns.stateForPull(repo.full_name, {
    pull: prIssue.number,
  });
  expect(closed).toMatchObject({ pr_closed: true, pr_merged: false });
});

test("stateForPull exposes only a Verify launch that has not submitted its review", async () => {
  const repo = S.createRepo("me/workflow-active-verify", REPO_PATH);
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Show active Verify",
    "body",
    "me",
  );
  const prIssue = S.createIssue(
    repo.id,
    "pull",
    "PR for active Verify",
    "body",
    "me",
  );
  const firstHead = "1".repeat(40);
  const secondHead = "2".repeat(40);
  S.createPull(prIssue.id, "active-verify-head", "main", firstHead, issue.id);
  const workflow = S.createWorkflow({
    name: "active-verify-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "23232323-2323-4232-8232-232323232323";
  S.registerAgentSession(parent, "lh-workflow", parent);
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: prIssue.number,
    status: "running",
    currentStep: "verify",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: parent,
  });
  // The run's start bounds which review submissions belong to it, so this fixture records it the
  // way `workflowRuns.start` does.
  S.emitWorkflowEvent(repo.id, "workflow_run.started", "me", {
    id: run.id,
    workflow_id: workflow.id,
    issue_number: issue.number,
    pr_number: prIssue.number,
    session_id: parent,
  });

  const firstVerifier = "24242424-2424-4242-8242-242424242424";
  confirmStepLaunch(
    repo.full_name,
    {
      run: run.id,
      step: "verify",
      sessionId: firstVerifier,
      agentName: `verifier #${run.id}-1`,
      pointers: [],
      headSha: firstHead,
    },
    parent,
  );
  expect(
    (
      await svc.workflowRuns.stateForPull(repo.full_name, {
        pull: prIssue.number,
      })
    )?.active_verify_head_sha,
  ).toBe(firstHead);

  await svc.reviews.create(
    repo.full_name,
    prIssue.number,
    { event: "PASS", headSha: firstHead, body: "First HEAD passes." },
    firstVerifier,
  );
  expect(
    (
      await svc.workflowRuns.stateForPull(repo.full_name, {
        pull: prIssue.number,
      })
    )?.active_verify_head_sha,
  ).toBeNull();

  const secondVerifier = "25252525-2525-4252-8252-252525252525";
  confirmStepLaunch(
    repo.full_name,
    {
      run: run.id,
      step: "verify",
      sessionId: secondVerifier,
      agentName: `verifier #${run.id}-2`,
      pointers: [],
      headSha: secondHead,
    },
    parent,
  );
  expect(
    (
      await svc.workflowRuns.stateForPull(repo.full_name, {
        pull: prIssue.number,
      })
    )?.active_verify_head_sha,
  ).toBe(secondHead);
});

test("a human hold sanitizes its reason and is authorized like a run update (#1307)", async () => {
  const repo = S.createRepo("me/workflow-hold", REPO_PATH);
  const workflow = S.createWorkflow({
    name: "hold-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "44444444-4444-4444-8444-444444444444";
  S.registerAgentSession(parent, "lh-workflow", parent);
  // The lifecycle guard reads the run's end from the linked PR, so the run needs its real rows.
  const holdIssue = S.createIssue(repo.id, "issue", "Hold", "", "me");
  const holdPr = S.createIssue(repo.id, "pull", "Hold PR", "", "me");
  S.createPull(holdPr.id, "hold-head", "main", null, holdIssue.id);
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: holdIssue.number,
    prNumber: holdPr.number,
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

  // A child session cannot hold a run it does not own.
  const stranger = "55555555-5555-4555-8555-555555555555";
  S.registerAgentSession(stranger, "workflow-step", stranger);
  expect(() =>
    svc.workflowRuns.awaitHuman(
      repo.full_name,
      { run: run.id, reason: "not mine to hold" },
      stranger,
    ),
  ).toThrowError(/parent session/);

  // A human CLI session may, the same way it may cancel a run whose parent died (#1307).
  const human = "66666666-6666-4666-8666-666666666666";
  S.registerAgentSession(human, "me", "cli");
  const held = svc.workflowRuns.awaitHuman(
    repo.full_name,
    { run: run.id, reason: "rework limit\nexceeded" },
    human,
  );
  expect(held.run.needs_human_reason).toBe("rework limit exceeded");
  expect(latestUpdatedPayload().needs_human_reason).toBe(
    "rework limit exceeded",
  );
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
    "Execute completed",
    "Execute step started",
  ]);
  expect(history[2].description).toContain("declared its turn done");
  expect(history[1].input).toContain("First launch");
  expect(history[4].input).toContain("Second launch");
  expect(history[0].input).toBeNull();
});

test("agentCosts and totalCost use the persisted Workflow participants", () => {
  const repo = S.createRepo("me/workflow-agent-costs", REPO_PATH);
  const workflow = S.createWorkflow({
    name: "agent-costs-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "11111111-0000-4000-8000-000000000001";
  const execute = "11111111-0000-4000-8000-000000000002";
  const verify = "11111111-0000-4000-8000-000000000003";
  const unrelated = "11111111-0000-4000-8000-000000000004";
  S.registerAgentSession(
    parent,
    "lh-workflow",
    parent,
    "orchestrator #1",
    "codex",
  );
  S.registerAgentSession(
    execute,
    "workflow-step",
    execute,
    "executor #1-1",
    "codex",
  );
  S.registerAgentSession(
    verify,
    "workflow-step",
    verify,
    "verifier #1-2",
    "codex",
  );
  S.registerAgentSession(
    unrelated,
    "workflow-step",
    unrelated,
    "other agent",
    "codex",
  );
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 10,
    prNumber: 20,
    status: "running",
    currentStep: "verify",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: parent,
  });
  S.appendWorkflowRunStepSession(run.id, "execute", execute);
  S.appendWorkflowRunStepSession(run.id, "verify", verify);
  const emptyRun = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 11,
    prNumber: 21,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 10,
    costLimitUsd: 10,
  });
  const pendingRun = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 12,
    prNumber: 22,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: unrelated,
  });
  expect(
    svc.workflowRuns.totalCost(repo.full_name, { run: emptyRun.id }),
  ).toEqual({ cost_usd: null, cost_status: "not_recorded" });
  expect(
    svc.workflowRuns.totalCost(repo.full_name, { run: pendingRun.id }),
  ).toEqual({ cost_usd: null, cost_status: "pending" });
  S.upsertSessionUsage(parent, {
    model: "priced",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 1.25,
  });
  S.upsertSessionUsage(execute, {
    model: "unpriced",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
  });

  expect(svc.workflowRuns.agentCosts(repo.full_name, { run: run.id })).toEqual([
    {
      role: "parent",
      session_count: 1,
      known_session_count: 1,
      pending_session_count: 0,
      unknown_session_count: 0,
      cost_usd: 1.25,
    },
    {
      role: "execute",
      session_count: 1,
      known_session_count: 0,
      pending_session_count: 0,
      unknown_session_count: 1,
      cost_usd: 0,
    },
    {
      role: "verify",
      session_count: 1,
      known_session_count: 0,
      pending_session_count: 1,
      unknown_session_count: 0,
      cost_usd: 0,
    },
  ]);

  expect(svc.workflowRuns.totalCost(repo.full_name, { run: run.id })).toEqual({
    cost_usd: null,
    cost_status: "unknown",
  });
  S.upsertSessionUsage(execute, {
    model: "unpriced",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0.5,
  });
  expect(svc.workflowRuns.totalCost(repo.full_name, { run: run.id })).toEqual({
    cost_usd: 1.75,
    cost_status: "partial",
  });
  S.upsertSessionUsage(verify, {
    model: "priced",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0.25,
  });
  expect(svc.workflowRuns.totalCost(repo.full_name, { run: run.id })).toEqual({
    cost_usd: 2,
    cost_status: "known",
  });

  const executeKnown = "11111111-0000-4000-8000-000000000005";
  const executeUnknown = "11111111-0000-4000-8000-000000000006";
  const executePending = "11111111-0000-4000-8000-000000000007";
  for (const sessionId of [executeKnown, executeUnknown, executePending]) {
    S.registerAgentSession(
      sessionId,
      "workflow-step",
      sessionId,
      "execute rework",
      "codex",
    );
    S.appendWorkflowRunStepSession(run.id, "execute", sessionId);
  }
  S.upsertSessionUsage(executeKnown, {
    model: "priced",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0.75,
  });
  S.upsertSessionUsage(executeUnknown, {
    model: "unpriced",
    input_tokens: 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
  });
  expect(svc.workflowRuns.agentCosts(repo.full_name, { run: run.id })).toEqual([
    {
      role: "parent",
      session_count: 1,
      known_session_count: 1,
      pending_session_count: 0,
      unknown_session_count: 0,
      cost_usd: 1.25,
    },
    {
      role: "execute",
      session_count: 4,
      known_session_count: 2,
      pending_session_count: 1,
      unknown_session_count: 1,
      cost_usd: 1.25,
    },
    {
      role: "verify",
      session_count: 1,
      known_session_count: 1,
      pending_session_count: 0,
      unknown_session_count: 0,
      cost_usd: 0.25,
    },
  ]);
});

test("history ranks lifecycle events by what a human judges the run by (#1867)", () => {
  const repo = S.createRepo("me/workflow-routine", REPO_PATH);
  const workflow = S.createWorkflow({
    name: "routine-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const prIssue = S.createIssue(repo.id, "pull", "Do the thing", "", "me");
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 11,
    prNumber: prIssue.number,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: "55555555-5555-4555-8555-555555555555",
  });
  const base = { id: run.id, issue_number: 11, pr_number: prIssue.number };
  const changesRequested = S.createReview(
    prIssue.id,
    `verifier #${run.id}-1`,
    "REQUEST_CHANGES",
    "one finding",
    "abc123",
    "workflow",
  );
  const passed = S.createReview(
    prIssue.id,
    `verifier #${run.id}-2`,
    "PASS",
    "looks right",
    "def456",
    "workflow",
  );

  // The event sequence a run actually produces today: Execute ends a turn and completes, Verify
  // reports twice, the parent reworks and re-activates Execute, and a cost hold interrupts it
  // until a human raises the limit.
  S.emitEvent(repo.id, "workflow_run.started", "parent", base);
  S.emitEvent(repo.id, "workflow_run.turn_done", "execute-agent", base);
  S.emitEvent(repo.id, "workflow_run.updated", "parent", {
    ...base,
    status: "running",
    current_step: "verify",
    transition: "advance_to_verify",
    rework_count: 0,
  });
  S.emitEvent(repo.id, "workflow_run.review_submitted", "verify-agent", {
    ...base,
    review_id: changesRequested.id,
  });
  S.emitEvent(repo.id, "workflow_run.updated", "parent", {
    ...base,
    status: "running",
    current_step: "execute",
    transition: "request_rework",
    rework_count: 1,
  });
  S.emitEvent(repo.id, "workflow_run.updated", "parent", {
    ...base,
    status: "running",
    current_step: "execute",
    transition: "activate_step",
    rework_count: 1,
  });
  S.emitEvent(repo.id, "workflow_run.cost_exceeded", "worker", {
    ...base,
    cost_usd: 40.0686945,
    limit_usd: 40,
  });
  S.emitEvent(repo.id, "workflow_run.updated", "parent", {
    ...base,
    status: "running",
    needs_human_reason: "Cost limit exceeded.",
  });
  S.emitEvent(repo.id, "workflow_run.cost_limit_increased", "me", {
    ...base,
    previous_limit_usd: 40,
    current_limit_usd: 60,
  });
  S.emitEvent(repo.id, "workflow_run.updated", "me", {
    ...base,
    status: "running",
    needs_human_reason: null,
  });
  S.emitEvent(repo.id, "workflow_run.github_event", "worker", {
    ...base,
    github_number: 512,
  });
  S.emitEvent(repo.id, "workflow_run.merge_conflict", "worker", base);
  S.emitEvent(repo.id, "workflow_run.review_submitted", "verify-agent", {
    ...base,
    review_id: passed.id,
  });
  // Legacy pings: nothing emits this since #1506, but older runs still carry thousands of them.
  S.emitEvent(repo.id, "workflow_run.usage_updated", "worker", base);
  // A type this serializer has never seen keeps the default look instead of throwing.
  S.emitEvent(repo.id, "workflow_run.teleported", "worker", base);
  S.emitEvent(repo.id, "workflow_run.closed", "me", base);

  const history = svc.workflowRuns.history(repo.full_name, { run: run.id });
  const ranked = (significance: string) =>
    history
      .filter((event) => event.significance === significance)
      .map((event) => `${event.type}:${event.label}`);

  // Cost holds, human waits, the two Execute/Verify completion points and the run's end are what
  // the dialog is opened for.
  expect(ranked("notable")).toEqual([
    "workflow_run.updated:Execute completed",
    "workflow_run.updated:Run rework requested",
    "workflow_run.cost_exceeded:Cost limit exceeded",
    "workflow_run.updated:Run needs human",
    // A merge conflict stalls the flow skeleton, so #1874 promoted it to notable.
    "workflow_run.merge_conflict:Merge conflict detected",
    "workflow_run.review_submitted:Review passed",
    "workflow_run.closed:Linked PR closed",
  ]);
  expect(ranked("routine")).toEqual([
    "workflow_run.turn_done:Turn done declared",
    "workflow_run.review_submitted:Review requested changes",
    "workflow_run.updated:Step agent activated",
    "workflow_run.updated:Run resumed",
    "workflow_run.usage_updated:Usage updated",
  ]);
  expect(ranked("default")).toEqual([
    "workflow_run.started:Run started",
    "workflow_run.cost_limit_increased:Cost limit raised",
    "workflow_run.github_event:GitHub feedback received",
    "workflow_run.teleported:Run teleported",
  ]);
  expect(history[2].description).toContain("Execute finished implementing");
  expect(history[3].description).toContain(`Review ${changesRequested.id}`);
  expect(history[6].description).toContain("$40.07 passed the $40.00 limit");
  expect(history[8].description).toContain("from $40.00 to $60.00");
  expect(history[10].description).toContain("GitHub PR #512");
  expect(history[12].description).toContain("Verify cleared this");
  expect(history[15].description).toContain(`PR #${prIssue.number} closed`);
});

test("history falls back to an unknown verdict when the review row is gone (#1867)", () => {
  const repo = S.createRepo("me/workflow-review-verdict", REPO_PATH);
  const workflow = S.createWorkflow({
    name: "verdict-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 12,
    // No PR issue row exists for this number, so no review can be resolved.
    prNumber: 22,
    status: "running",
    currentStep: "verify",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: "66666666-6666-4666-8666-666666666666",
  });
  S.emitEvent(repo.id, "workflow_run.review_submitted", "verify-agent", {
    id: run.id,
    issue_number: 12,
    pr_number: 22,
    review_id: 77,
  });

  const history = svc.workflowRuns.history(repo.full_name, { run: run.id });
  expect(history).toHaveLength(1);
  expect(history[0].label).toBe("Review submitted");
  expect(history[0].significance).toBe("routine");
  expect(history[0].description).toContain("Review 77");
});

test("one state observation loads the run's event trail once (#1912)", async () => {
  const { repo } = freshRepo("me/workflow-one-load");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "One load",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "one-load-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const loads = vi.spyOn(S, "workflowRunObservationTrail");
  try {
    // Every observation in one read shares the single trail the call loaded.
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id });
    expect(loads).toHaveBeenCalledTimes(1);
  } finally {
    loads.mockRestore();
  }
}, 20_000);

test("event rows written before the typed payloads are still observable (#1912)", async () => {
  const { repo } = freshRepo("me/workflow-legacy-payloads");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Legacy payloads",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "legacy-payload-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  // Shapes that predate the typed payload map: a launch with no `step`, an update with no
  // `current_step`, and a turn done with no `head_sha`. Each must land on the same fallback the
  // ad-hoc casts produced, not throw.
  S.emitEvent(repo.id, "workflow_step.launched", "parent", {
    id: started.run.id,
  });
  S.emitEvent(repo.id, "workflow_run.updated", "parent", {
    id: started.run.id,
    status: "running",
  });
  S.emitEvent(repo.id, "workflow_run.turn_done", "executor", {
    id: started.run.id,
  });

  const status = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(status.last_turn_done_at).not.toBeNull();
  // No identifiable Execute round and no identifiable Verify launch, so neither is credited.
  expect(status.turn_done_for_active_execute).toBe(false);
  expect(status.verify_launched_after_turn_done).toBe(false);
  expect(status.unaddressed_out_of_band_reviews).toEqual([]);
  expect(status.active_step).toBeNull();

  // The malformed-but-visible timeline still renders, with the missing keys simply absent.
  const history = svc.workflowRuns.history(repo.full_name, {
    run: started.run.id,
  });
  expect(history.map((event) => event.type)).toContain(
    "workflow_step.launched",
  );
}, 20_000);

test("an observation after a release reads the cleared hold, not the earlier one (#1912)", async () => {
  const { repo } = freshRepo("me/workflow-hold-reread");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Hold reread",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "hold-reread-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
    parent,
  );
  confirmStepLaunch(
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
  const limitUsd = holdOnCost(
    repo.full_name,
    started.run.id,
    exec.session_id,
    parent,
  );

  // The human clears the hold by raising the limit. Its `workflow_run.updated` event is the only
  // record that the hold is gone, so the state read after it must show the run row as that event
  // left it.
  releaseCostHold(repo.full_name, started.run.id, limitUsd);

  const observed = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(observed.awaiting_human).toBe(false);
  expect(observed.needs_human_reason).toBeNull();
  expect(observed.active_step).toBe("execute");
}, 30_000);

test("successive runs on one PR do not blend their review submissions", async () => {
  const { repo } = freshRepo("me/workflow-attempt-window");
  const issue = S.createIssue(repo.id, "issue", "Two attempts", "", "me");
  const prIssue = S.createIssue(repo.id, "pull", "Two attempts PR", "", "me");
  S.createPull(prIssue.id, "attempts", "main", "sha", issue.id);
  const workflow = S.createWorkflow({
    name: "attempt-window-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const startRunOnPull = (parent: string) => {
    const row = S.createWorkflowRun({
      workflowId: workflow.id,
      repoId: repo.id,
      issueNumber: issue.number,
      prNumber: prIssue.number,
      status: "running",
      currentStep: "verify",
      costIncrementUsd: 10,
      costLimitUsd: 10,
      parentSessionId: parent,
    });
    S.emitWorkflowEvent(repo.id, "workflow_run.started", "me", {
      id: row.id,
      workflow_id: workflow.id,
      issue_number: issue.number,
      pr_number: prIssue.number,
      session_id: parent,
    });
    return row.id;
  };
  const submitReview = (verdict: "PASS" | "REQUEST_CHANGES") => {
    const review = S.createReview(
      prIssue.id,
      "human",
      verdict,
      `${verdict} on the PR`,
      "sha",
    );
    S.emitEvent(repo.id, "pull_request.review_submitted", "human", {
      number: prIssue.number,
      state: verdict,
      comments: 0,
      session_id: null,
      review_id: review.id,
      submission_head_sha: "sha",
      source_payload_version: 1,
    });
    return review.id;
  };

  const first = startRunOnPull("11111111-1111-4111-8111-111111111111");
  const firstReview = submitReview("REQUEST_CHANGES");
  const second = startRunOnPull("22222222-2222-4222-8222-222222222222");
  const secondReview = submitReview("PASS");

  // A review source carries only the PR number, so the attempt it belongs to is decided by the two
  // starts it sits between — never by the PR alone.
  const reviewEntries = (run: number) =>
    svc.workflowRuns
      .history(repo.full_name, { run })
      .filter((entry) => entry.type === "pull_request.review_submitted")
      .map((entry) => entry.label);

  expect(reviewEntries(first)).toEqual(["Review requested changes"]);
  expect(reviewEntries(second)).toEqual(["Review passed"]);
  // Each verdict is resolved from the review row the window kept, not from the PR's latest review.
  expect(S.listReviews(prIssue.id).map((review) => review.id)).toEqual([
    firstReview,
    secondReview,
  ]);
}, 20_000);

test("state reports every area of the run in one read", async () => {
  const { repo } = freshRepo("me/state-one-read");
  const issue = S.createIssue(
    repo.id,
    "issue",
    "Observe the run",
    "## Acceptance criteria\n- [ ] Works\n",
    "me",
  );
  const workflow = S.createWorkflow({
    name: "state-one-read-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "aaaaaaa1-1111-4111-8111-aaaaaaaaaaaa";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const exec = await svc.workflowRuns.launchStep(
    repo.full_name,
    { run: started.run.id, step: "execute" },
    parent,
  );
  confirmStepLaunch(
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
  const headSha = commit(started.worktree, "impl.txt", "v1\n");
  await svc.workflowRuns.turnDone(
    repo.full_name,
    { run: started.run.id },
    exec.session_id,
  );

  const runRow = S.getWorkflowRun(started.run.id)!;
  const prIssue = S.getIssue(repo.id, runRow.pr_number)!;
  const issueComment = S.createComment(
    issue.id,
    "me",
    "Extra context on the issue.",
    "human",
  );
  const pullComment = S.createComment(
    prIssue.id,
    "me",
    "Please rename this.",
    "human",
  );
  const thread = S.createDiffFeedbackThread({
    issueId: prIssue.id,
    prNumber: prIssue.number,
    baseSha: "base",
    headSha,
    path: "impl.txt",
    originalPath: null,
    side: "RIGHT",
    startLine: 1,
    endLine: 1,
    actor: "me",
    authorType: "human",
  });
  const threadMessage = S.createDiffFeedbackMessage(
    thread.id,
    "me",
    "Rename this file.",
    "human",
  );
  S.saveGithubFeedbackObservation({
    issueId: prIssue.id,
    kind: "review_comment",
    githubId: 4242,
    contentHash: "hash-v1",
    updatedAt: "2026-08-01T00:00:00Z",
  });

  const state = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });

  // run row — including the live child, which distinguishes "no child" from an unreadable run.
  expect(state).toMatchObject({
    state_version: 1,
    id: started.run.id,
    issue_number: issue.number,
    pr_number: prIssue.number,
    current_step: "execute",
    active_step: "execute",
    active_session_id: exec.session_id,
    turn_done_for_active_execute: true,
  });
  expect(state.last_turn_done_at).not.toBeNull();
  // commit
  expect(state).toMatchObject({
    head_sha: headSha,
    head_ahead_of_base: true,
    head_ahead_of_latest_review: false,
  });
  // review
  expect(state.latest_review).toBeNull();
  expect(state.unaddressed_out_of_band_reviews).toEqual([]);
  expect(state.steps.execute.complete).toBe(true);
  // comment
  expect(state.latest_issue_comment).toMatchObject({
    id: issueComment.id,
    author_type: "human",
  });
  expect(state.latest_pull_comment).toMatchObject({
    id: pullComment.id,
    author_type: "human",
  });
  // diff feedback
  expect(state.unaddressed_diff_feedback).toEqual([
    { thread_id: thread.id, latest_comment_id: threadMessage.id },
  ]);
  // GitHub feedback — the revision, since the state carries no body to compare.
  expect(state.github_feedback).toEqual([
    {
      kind: "review_comment",
      github_id: 4242,
      content_hash: "hash-v1",
      updated_at: "2026-08-01T00:00:00Z",
    },
  ]);
  // PR lifecycle
  expect(state).toMatchObject({
    pr_closed: false,
    pr_merged: false,
    merge_conflict: false,
  });
  // hold
  expect(state).toMatchObject({
    needs_human_reason: null,
    awaiting_human: false,
    pending_effect_receipt: null,
    rework_count: 0,
  });
  expect(state.rework_limit).toBeGreaterThan(0);
  expect(state.total_cost.cost_status).toBeTruthy();
}, 20_000);

test("state refuses a wire version it does not produce", async () => {
  const { repo } = freshRepo("me/state-version");
  const issue = S.createIssue(repo.id, "issue", "Version", "", "me");
  const workflow = S.createWorkflow({
    name: "state-version-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    "aaaaaaa2-2222-4222-8222-aaaaaaaaaaaa",
  );

  const current = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
    expectStateVersion: 1,
  });
  expect(current.state_version).toBe(1);
  // A caller written against another shape is told so rather than handed a converted state.
  await expect(
    svc.workflowRuns.state(repo.full_name, {
      run: started.run.id,
      expectStateVersion: 99,
    }),
  ).rejects.toMatchObject({ status: 422 });
}, 20_000);

test("an unobserved merge stays null and stops the run instead of reading as clean", async () => {
  const { repo, path } = freshRepo("me/state-unobserved-merge");
  const issue = S.createIssue(repo.id, "issue", "Unobserved", "", "me");
  const workflow = S.createWorkflow({
    name: "state-unobserved-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const parent = "aaaaaaa3-3333-4333-8333-aaaaaaaaaaaa";
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    parent,
  );
  const prIssue = S.getIssue(
    repo.id,
    S.getWorkflowRun(started.run.id)!.pr_number,
  )!;
  const pull = S.getPull(prIssue.id)!;
  const headSha = commit(started.worktree, "impl.txt", "v1\n");
  S.setHeadSha(prIssue.id, headSha);

  expect(
    await svc.workflowRuns.state(repo.full_name, { run: started.run.id }),
  ).toMatchObject({ merge_conflict: false, done: false });

  // Drop the branch the PR points at: the pair can no longer be resolved, so nothing is compared.
  gitAt(path, ["worktree", "remove", "--force", started.worktree]);
  gitAt(path, ["branch", "-D", pull.head_ref]);

  const state = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  // The unobserved values stay null rather than being rounded to false, which is what tells the
  // parent to stop instead of advancing on a merge nobody looked at.
  expect(state).toMatchObject({
    head_sha: headSha,
    head_ahead_of_base: null,
    merge_conflict: null,
    done: null,
  });
}, 20_000);

test("state stays on the PR the run pinned after it closes", async () => {
  const { repo } = freshRepo("me/state-pinned-pr");
  const issue = S.createIssue(repo.id, "issue", "Pinned", "", "me");
  const workflow = S.createWorkflow({
    name: "state-pinned-wf",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const started = await svc.workflowRuns.start(
    repo.full_name,
    { issue: issue.number, workflowId: workflow.id },
    "aaaaaaa4-4444-4444-8444-aaaaaaaaaaaa",
  );
  const pinned = S.getIssue(
    repo.id,
    S.getWorkflowRun(started.run.id)!.pr_number,
  )!;
  S.updateIssue(pinned.id, { state: "closed" });
  // A later attempt on the same issue opens another PR; the run keeps reading its own.
  const retry = S.createIssue(
    repo.id,
    "pull",
    "Retry",
    `Closes #${issue.number}`,
    "me",
  );
  S.createPull(retry.id, "loophub/pr-retry", "main", null, issue.id);

  const state = await svc.workflowRuns.state(repo.full_name, {
    run: started.run.id,
  });
  expect(state.pr_number).toBe(pinned.number);
  expect(state.pr_closed).toBe(true);
  expect(state.done).toBe(false);
}, 20_000);
