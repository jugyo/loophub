import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-attempt-supersede-"));
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
  const path = mkdtempSync(join(tmpdir(), "lh-attempt-repo-"));
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

async function createAttempt(
  repo: string,
  issue: number,
  head: string,
  sessionId?: string,
) {
  return svc.pulls.create(
    repo,
    {
      title: head,
      head,
      base: "main",
      issue,
      parallel: true,
    },
    sessionId,
  );
}

beforeAll(async () => {
  S = await import("./store.ts");
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  for (const path of repoPaths) rmSync(path, { recursive: true, force: true });
});

test("merging an attempt closes open siblings with comments and traceable events without changing their sessions", async () => {
  const repo = await makeRepo("me/merge-attempts");
  const issue = svc.issues.create("me/merge-attempts", { title: "choose one" });
  branch(repo.path, "adopted", true);
  branch(repo.path, "sibling-a");
  branch(repo.path, "sibling-b");
  svc.sessions.register({
    id: "running-sibling",
    agent: "lh-build",
    session: "running-sibling",
  });

  const adopted = await createAttempt(
    "me/merge-attempts",
    issue.number,
    "adopted",
  );
  const siblingA = await createAttempt(
    "me/merge-attempts",
    issue.number,
    "sibling-a",
    "running-sibling",
  );
  const siblingB = await createAttempt(
    "me/merge-attempts",
    issue.number,
    "sibling-b",
  );
  const sessionBefore = S.getAgentSession("running-sibling");

  await svc.pulls.merge(
    "me/merge-attempts",
    adopted.number,
    "merge",
    "merge-session",
  );

  expect((await svc.issues.get("me/merge-attempts", issue.number)).state).toBe(
    "closed",
  );
  for (const sibling of [siblingA, siblingB]) {
    expect(
      (await svc.pulls.get("me/merge-attempts", sibling.number)).state,
    ).toBe("closed");
    const row = S.getIssue(repo.id, sibling.number)!;
    expect(S.listComments(row.id).map((comment) => comment.body)).toEqual([
      `Superseded by #${adopted.number}.`,
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
        superseded_by: adopted.number,
      },
      {
        number: siblingB.number,
        linked_issue: issue.number,
        superseded_by: adopted.number,
      },
    ]),
  );
});

test("closing an issue directly closes every open attempt and is idempotent", async () => {
  const repo = await makeRepo("me/direct-close");
  const issue = svc.issues.create("me/direct-close", { title: "stop all" });
  branch(repo.path, "direct-a");
  branch(repo.path, "direct-b");
  const attempts = await Promise.all([
    createAttempt("me/direct-close", issue.number, "direct-a"),
    createAttempt("me/direct-close", issue.number, "direct-b"),
  ]);

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

  for (const attempt of attempts) {
    expect((await svc.pulls.get("me/direct-close", attempt.number)).state).toBe(
      "closed",
    );
    const row = S.getIssue(repo.id, attempt.number)!;
    expect(S.listComments(row.id).map((comment) => comment.body)).toEqual([
      `Closed because linked issue #${issue.number} was closed.`,
    ]);
  }
  const closeEvents = S.listEvents(0, repo.id, 100).filter(
    (event) => event.type === "pull_request.closed",
  );
  expect(closeEvents).toHaveLength(2);
  expect(
    closeEvents.map((event) => JSON.parse(event.payload).superseded_by),
  ).toEqual([undefined, undefined]);
});
