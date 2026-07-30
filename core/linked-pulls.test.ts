import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

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
    name: `linked-pull-close-${prNumber}`,
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

beforeAll(async () => {
  S = await import("./store.ts");
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  for (const path of repoPaths) rmSync(path, { recursive: true, force: true });
});

test("merging a historical linked PR leaves other open linked PRs unchanged", async () => {
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
    ).toBe("open");
    const row = S.getIssue(repo.id, sibling.number)!;
    expect(S.listComments(row.id)).toEqual([]);
  }
  expect(S.getAgentSession("running-sibling")).toEqual(sessionBefore);

  const closeEvents = S.listEvents(0, repo.id, 100).filter(
    (event) => event.type === "pull_request.closed",
  );
  expect(closeEvents).toHaveLength(0);
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
