import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

const HOME = mkdtempSync(join(tmpdir(), "lh-linked-pulls-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
const repoPaths: string[] = [];

function git(repoPath: string, args: string[]) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

async function makeRepo(name: string) {
  const path = mkdtempSync(join(tmpdir(), "lh-linked-pulls-repo-"));
  repoPaths.push(path);
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.email", "t@t.local"]);
  git(path, ["config", "user.name", "tester"]);
  writeFileSync(join(path, "base.txt"), "base\n");
  git(path, ["add", "-A"]);
  git(path, ["commit", "-qm", "base"]);
  const repo = await svc.repos.create({ path, name });
  return { id: repo.id, path };
}

function branch(repoPath: string, name: string, withCommit = false) {
  git(repoPath, ["branch", name, "main"]);
  if (!withCommit) return;
  git(repoPath, ["checkout", "-q", name]);
  writeFileSync(join(repoPath, `${name}.txt`), `${name}\n`);
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-qm", name]);
  git(repoPath, ["checkout", "-q", "main"]);
}

async function createHistoricalLinkedPull(
  repo: string,
  issue: number,
  head: string,
  sessionId?: string,
) {
  const [owner, name] = repo.split("/") as [string, string];
  const repoRow = S.getRepo(owner, name)!;
  const linkedIssue = S.getIssue(repoRow.id, issue)!;
  const row = S.createIssue(repoRow.id, "pull", head, "", sessionId ?? "test");
  S.createPull(row.id, head, "main", null, linkedIssue.id);
  if (sessionId) S.setPullSession(row.id, sessionId);
  return svc.pulls.get(repo, row.number);
}

function attachWorkflowRun(
  repoId: number,
  issueNumber: number,
  prNumber: number,
  parentSessionId: string,
) {
  const workflow = S.createWorkflow({
    name: `linked-pull-close-${repoId}-${prNumber}-${parentSessionId}`,
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  return S.createWorkflowRun({
    workflowId: workflow.id,
    repoId,
    issueNumber,
    prNumber,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId,
  });
}

function registerWorkflowPane(repoId: number, runId: number, paneId: string) {
  const launchId = `workflow-run-${runId}-${paneId}`;
  S.registerHerdrPane({ repoId, launchId, paneId });
  S.linkHerdrPaneResource({
    repoId,
    launchId,
    resourceKind: "workflow_run",
    resourceKey: String(runId),
  });
}

beforeAll(async () => {
  S = await import("./store.ts");
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  for (const path of repoPaths) rmSync(path, { recursive: true, force: true });
});

test("closing a PR enqueues a worker job that stops only its workflow agents", async () => {
  const repo = await makeRepo("me/close-workflow-agents");
  const issue = svc.issues.create("me/close-workflow-agents", {
    title: "stop this run",
  });
  branch(repo.path, "target");
  branch(repo.path, "unrelated");
  const target = await createHistoricalLinkedPull(
    "me/close-workflow-agents",
    issue.number,
    "target",
  );
  const unrelatedIssue = svc.issues.create("me/close-workflow-agents", {
    title: "keep this run",
  });
  const unrelated = await createHistoricalLinkedPull(
    "me/close-workflow-agents",
    unrelatedIssue.number,
    "unrelated",
  );
  const olderTargetRun = attachWorkflowRun(
    repo.id,
    issue.number,
    target.number,
    "older-target-parent",
  );
  const targetRun = attachWorkflowRun(
    repo.id,
    issue.number,
    target.number,
    "target-parent",
  );
  const unrelatedRun = attachWorkflowRun(
    repo.id,
    unrelatedIssue.number,
    unrelated.number,
    "unrelated-parent",
  );
  registerWorkflowPane(repo.id, olderTargetRun.id, "w1:p0");
  registerWorkflowPane(repo.id, targetRun.id, "w1:p1");
  registerWorkflowPane(repo.id, unrelatedRun.id, "w1:p9");
  svc.sessions.register({
    id: "target-executor",
    agent: "workflow-step",
    session: "target-executor",
  });
  S.registerAgentExecutionTarget({
    sessionId: "target-executor",
    provider: "herdr",
    targetId: "w1:p2",
  });
  S.updateWorkflowRun(targetRun.id, {
    activeStep: "execute",
    activeSessionId: "target-executor",
  });

  const stopped: string[] = [];
  svc.pulls.update(
    "me/close-workflow-agents",
    target.number,
    { state: "closed" },
    "closer",
  );

  const jobs = [svc.jobs.claimNext(), svc.jobs.claimNext()];
  expect(jobs).toEqual([
    expect.objectContaining({
      type: "workflow_agents.stop",
      repo_id: repo.id,
      status: "running",
    }),
    expect.objectContaining({
      type: "workflow_agents.stop",
      repo_id: repo.id,
      status: "running",
    }),
  ]);
  expect(jobs.map((job) => JSON.parse(job!.params))).toEqual([
    { run: olderTargetRun.id },
    { run: targetRun.id },
  ]);
  expect(
    (await svc.pulls.get("me/close-workflow-agents", target.number)).state,
  ).toBe("closed");
  expect(
    (await svc.pulls.get("me/close-workflow-agents", unrelated.number)).state,
  ).toBe("open");
  for (const run of [olderTargetRun, targetRun]) {
    S.updateWorkflowRun(run.id, { status: "completed" });
    await svc.workflowAgentStop.run(
      "me/close-workflow-agents",
      { run: run.id },
      {
        killPaneForegroundProcess: async (_repo, paneId) => {
          stopped.push(paneId);
          return true;
        },
      },
    );
  }
  expect(stopped).toEqual(["w1:p0", "w1:p1", "w1:p2"]);
  for (const job of jobs) svc.jobs.finish(job!.id, { status: "done" });
});

test("parent registration enqueues the stop after a PR closes during launch", async () => {
  const repo = await makeRepo("me/close-starting-workflow");
  const issue = svc.issues.create("me/close-starting-workflow", {
    title: "starting run",
  });
  branch(repo.path, "starting");
  const pull = await createHistoricalLinkedPull(
    "me/close-starting-workflow",
    issue.number,
    "starting",
  );
  const run = attachWorkflowRun(
    repo.id,
    issue.number,
    pull.number,
    "starting-parent",
  );
  svc.pulls.update(
    "me/close-starting-workflow",
    pull.number,
    { state: "closed" },
    "closer",
  );
  expect(
    (await svc.pulls.get("me/close-starting-workflow", pull.number)).state,
  ).toBe("closed");
  expect(svc.jobs.claimNext()).toBeNull();

  svc.workflowInstructions.registerParentPane("me/close-starting-workflow", {
    run: run.id,
    launch_id: "starting-parent",
    session_name: "me-close-starting-workflow",
    pane_id: "w3:p1",
    launched_at: new Date().toISOString(),
  });
  const stopJob = svc.jobs.claimNext();
  expect(stopJob).toMatchObject({
    type: "workflow_agents.stop",
    repo_id: repo.id,
  });
  expect(JSON.parse(stopJob!.params)).toEqual({ run: run.id });
  svc.jobs.finish(stopJob!.id, { status: "done" });
});

test("merging a historical linked PR closes its Issue and sibling PRs", async () => {
  const repo = await makeRepo("me/merge-linked-pulls");
  const issue = svc.issues.create("me/merge-linked-pulls", {
    title: "choose one",
  });
  branch(repo.path, "adopted", true);
  branch(repo.path, "sibling-a");
  branch(repo.path, "sibling-b");
  svc.sessions.register({
    id: "running-sibling",
    agent: "lh-build",
    session: "running-sibling",
  });

  const adopted = await createHistoricalLinkedPull(
    "me/merge-linked-pulls",
    issue.number,
    "adopted",
  );
  const siblingA = await createHistoricalLinkedPull(
    "me/merge-linked-pulls",
    issue.number,
    "sibling-a",
    "running-sibling",
  );
  const siblingB = await createHistoricalLinkedPull(
    "me/merge-linked-pulls",
    issue.number,
    "sibling-b",
  );
  const siblingRun = attachWorkflowRun(
    repo.id,
    issue.number,
    siblingA.number,
    "sibling-parent",
  );
  const sessionBefore = S.getAgentSession("running-sibling");

  await svc.pulls.merge(
    "me/merge-linked-pulls",
    adopted.number,
    "merge",
    "merge-session",
  );

  expect(
    (await svc.issues.get("me/merge-linked-pulls", issue.number)).state,
  ).toBe("closed");
  for (const sibling of [siblingA, siblingB]) {
    expect(
      (await svc.pulls.get("me/merge-linked-pulls", sibling.number)).state,
    ).toBe("closed");
    const row = S.getIssue(repo.id, sibling.number)!;
    expect(S.listComments(row.id).map((comment) => comment.body)).toEqual([
      `Closed because linked issue #${issue.number} was closed.`,
    ]);
  }
  expect(S.getAgentSession("running-sibling")).toEqual(sessionBefore);

  const closeEvents = S.listEvents(0, repo.id, 100).filter(
    (event) => event.type === "pull_request.closed",
  );
  expect(closeEvents).toHaveLength(2);
  expect(closeEvents.map((event) => JSON.parse(event.payload))).toEqual(
    expect.arrayContaining([
      {
        number: siblingA.number,
        linked_issue: issue.number,
        source_payload_version: 1,
      },
      {
        number: siblingB.number,
        linked_issue: issue.number,
        source_payload_version: 1,
      },
    ]),
  );
  const mergedEvents = S.listEvents(0, repo.id, 100).filter(
    (event) => event.type === "pull_request.merged",
  );
  expect(mergedEvents).toHaveLength(1);
  expect(JSON.parse(mergedEvents[0].payload)).toMatchObject({
    number: adopted.number,
    source_payload_version: 1,
  });
  expect(
    S.eventsForWorkflowRun(repo.id, siblingRun.id).filter(
      (event) => event.type === "workflow_run.closed",
    ),
  ).toEqual([]);
});

test("closing an issue directly closes every open linked PR and is idempotent", async () => {
  const repo = await makeRepo("me/direct-close");
  const issue = svc.issues.create("me/direct-close", { title: "stop all" });
  branch(repo.path, "direct-a");
  branch(repo.path, "direct-b");
  const pulls = await Promise.all([
    createHistoricalLinkedPull("me/direct-close", issue.number, "direct-a"),
    createHistoricalLinkedPull("me/direct-close", issue.number, "direct-b"),
  ]);
  const pullRun = attachWorkflowRun(
    repo.id,
    issue.number,
    pulls[0].number,
    "direct-close-parent",
  );

  svc.issues.update(
    "me/direct-close",
    issue.number,
    { state: "closed" },
    "closer",
  );
  svc.issues.update(
    "me/direct-close",
    issue.number,
    { state: "closed" },
    "closer",
  );

  for (const pull of pulls) {
    expect((await svc.pulls.get("me/direct-close", pull.number)).state).toBe(
      "closed",
    );
    const row = S.getIssue(repo.id, pull.number)!;
    expect(S.listComments(row.id).map((comment) => comment.body)).toEqual([
      `Closed because linked issue #${issue.number} was closed.`,
    ]);
  }
  const closeEvents = S.listEvents(0, repo.id, 100).filter(
    (event) => event.type === "pull_request.closed",
  );
  expect(closeEvents).toHaveLength(2);
  // The close source carries the cutover marker and no run-scoped twin follows it: a run reads the
  // PR's own state when its subscription selects the close.
  expect(closeEvents.map((event) => JSON.parse(event.payload))).toEqual(
    expect.arrayContaining([
      {
        number: pulls[0].number,
        linked_issue: issue.number,
        source_payload_version: 1,
      },
      {
        number: pulls[1].number,
        linked_issue: issue.number,
        source_payload_version: 1,
      },
    ]),
  );
  expect(
    S.eventsForWorkflowRun(repo.id, pullRun.id).filter(
      (event) => event.type === "workflow_run.closed",
    ),
  ).toEqual([]);
});
