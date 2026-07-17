import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-ghfeedback-sync-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let sync: typeof import("./github-feedback-sync.ts");
let github: typeof import("./github.ts");
let repoPath: string;
let workflowId: number;
type GithubPrFeedback = import("./github-feedback-sync.ts").GithubPrFeedback;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function workflowGithubPull(githubNumber: number): Promise<{
  number: number;
  url: string;
  runId: number;
  parentSessionId: string;
}> {
  const branch = `feedback-${githubNumber}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "feedback\n");
  git(["add", "-A"]);
  git(["commit", "-qm", branch]);
  git(["checkout", "-q", "main"]);
  const pr = await svc.pulls.create("me/proj", {
    title: branch,
    head: branch,
    base: "main",
  });
  const url = `https://github.com/upstream/proj/pull/${githubNumber}`;
  svc.pulls.recordGithubPull("me/proj", pr.number, {
    github_number: githubNumber,
    url,
  });
  const repo = S.getRepo("me", "proj")!;
  const parentSessionId = `parent-${githubNumber}`;
  const run = S.createWorkflowRun({
    workflowId,
    repoId: repo.id,
    issueNumber: pr.number,
    prNumber: pr.number,
    status: "running",
    currentStep: "execute",
    parentSessionId,
  });
  return { number: pr.number, url, runId: run.id, parentSessionId };
}

function feedback(input: {
  kind: "issue_comment" | "review" | "review_comment";
  id: number;
  body: string;
  updatedAt?: string;
}): GithubPrFeedback {
  return {
    ...input,
    updatedAt: input.updatedAt ?? "2026-07-01T00:00:00Z",
  };
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  sync = await import("./github-feedback-sync.ts");
  github = await import("./github.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-ghfeedback-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "base\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  await svc.repos.create({ path: repoPath, name: "me/proj" });
  workflowId = S.createWorkflow({
    name: "feedback-test",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  }).id;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("emits source and Workflow projection events for aggregated GitHub feedback", async () => {
  const pull = await workflowGithubPull(101);
  const result = await sync.syncGithubFeedback({
    async fetchFeedback(_repoPath, url) {
      if (url !== pull.url) return [];
      return [
        feedback({ kind: "issue_comment", id: 11, body: "conversation" }),
        feedback({ kind: "review", id: 12, body: "review body" }),
        feedback({ kind: "review_comment", id: 13, body: "inline" }),
      ];
    },
  });

  const source = result.emitted.find(
    (candidate) =>
      candidate.type === "pull_request.github_feedback" &&
      JSON.parse(candidate.payload).number === pull.number,
  );
  expect(JSON.parse(source!.payload)).toEqual({
    number: pull.number,
    workflow_run_id: pull.runId,
    parent_session_id: pull.parentSessionId,
    github_number: 101,
    github_url: pull.url,
    feedback: [
      {
        kind: "issue_comment",
        id: 11,
        updated_at: "2026-07-01T00:00:00Z",
        reference: "repos/upstream/proj/issues/comments/11",
      },
      {
        kind: "review",
        id: 12,
        updated_at: "2026-07-01T00:00:00Z",
        reference: "repos/upstream/proj/pulls/101/reviews/12",
      },
      {
        kind: "review_comment",
        id: 13,
        updated_at: "2026-07-01T00:00:00Z",
        reference: "repos/upstream/proj/pulls/comments/13",
      },
    ],
  });
  const projection = result.emitted.find(
    (candidate) =>
      candidate.type === "workflow_run.github_event" &&
      JSON.parse(candidate.payload).number === pull.number,
  );
  expect(JSON.parse(projection!.payload)).toEqual({
    id: pull.runId,
    number: pull.number,
    pr_number: pull.number,
    parent_session_id: pull.parentSessionId,
    source_event_id: source!.id,
    source_event_type: "pull_request.github_feedback",
    github_number: 101,
    github_url: pull.url,
    feedback: JSON.parse(source!.payload).feedback,
  });
});

test("skips GitHub feedback when the Workflow run has no parent session", async () => {
  // Same setup as workflowGithubPull but without parentSessionId — the sweep only targets
  // running Workflow runs that have a parent observer.
  const githubNumber = 150;
  const branch = `feedback-${githubNumber}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "feedback\n");
  git(["add", "-A"]);
  git(["commit", "-qm", branch]);
  git(["checkout", "-q", "main"]);
  const pr = await svc.pulls.create("me/proj", {
    title: branch,
    head: branch,
    base: "main",
  });
  const url = `https://github.com/upstream/proj/pull/${githubNumber}`;
  svc.pulls.recordGithubPull("me/proj", pr.number, {
    github_number: githubNumber,
    url,
  });
  const repo = S.getRepo("me", "proj")!;
  S.createWorkflowRun({
    workflowId,
    repoId: repo.id,
    issueNumber: pr.number,
    prNumber: pr.number,
    status: "running",
    currentStep: "execute",
  });

  const called: string[] = [];
  const deps = {
    async fetchFeedback(_repoPath: string, urlArg: string) {
      called.push(urlArg);
      return [feedback({ kind: "issue_comment", id: 25, body: "waiting" })];
    },
  };

  const result = await sync.syncGithubFeedback(deps);
  expect(called).not.toContain(url);
  expect(
    result.emitted.some(
      (event) => JSON.parse(event.payload).number === pr.number,
    ),
  ).toBe(false);
});

test("detects edits and durably suppresses the same comment content", async () => {
  const pull = await workflowGithubPull(102);
  let current = feedback({
    kind: "issue_comment",
    id: 21,
    body: "first",
  });
  const deps = {
    async fetchFeedback(_repoPath: string, url: string) {
      return url === pull.url ? [current] : [];
    },
  };

  const first = await sync.syncGithubFeedback(deps);
  expect(
    first.emitted.filter(
      (event) =>
        event.type === "workflow_run.github_event" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(1);

  // Calling the public sweep again models a worker restart: dedupe state must come from SQLite,
  // not process memory.
  const afterRestart = await sync.syncGithubFeedback(deps);
  expect(
    afterRestart.emitted.filter(
      (event) =>
        event.type === "workflow_run.github_event" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(0);

  current = feedback({
    kind: "issue_comment",
    id: 21,
    body: "edited",
    updatedAt: "2026-07-02T00:00:00Z",
  });
  const edited = await sync.syncGithubFeedback(deps);
  expect(
    edited.emitted.filter(
      (event) =>
        event.type === "workflow_run.github_event" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(1);
  const unchangedEdit = await sync.syncGithubFeedback(deps);
  expect(
    unchangedEdit.emitted.filter(
      (event) =>
        event.type === "workflow_run.github_event" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(0);
});

test("notifies once when a pending review with the same id and body is submitted", async () => {
  const pull = await workflowGithubPull(175);
  let review: Record<string, unknown> = {
    id: 27,
    body: "same review body",
    state: "PENDING",
    submitted_at: null,
  };
  const deps = {
    async fetchFeedback(repoPath: string, url: string) {
      return github.fetchGithubPrFeedback(
        repoPath,
        url,
        async (_cwd, endpoint) =>
          JSON.stringify(endpoint.endsWith("/reviews") ? [[review]] : [[]]),
      );
    },
  };

  const pending = await sync.syncGithubFeedback(deps);
  expect(
    pending.emitted.filter(
      (event) => JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(0);

  review = {
    id: 27,
    body: "same review body",
    state: "COMMENTED",
    submitted_at: "2026-07-03T00:00:00Z",
  };
  const submitted = await sync.syncGithubFeedback(deps);
  expect(
    submitted.emitted.filter(
      (event) =>
        event.type === "workflow_run.github_event" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(1);

  const unchanged = await sync.syncGithubFeedback(deps);
  expect(
    unchanged.emitted.filter(
      (event) =>
        event.type === "workflow_run.github_event" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(0);
});

test("notifies once for a submitted review with no body", async () => {
  const pull = await workflowGithubPull(176);
  const deps = {
    async fetchFeedback(repoPath: string, url: string) {
      return github.fetchGithubPrFeedback(
        repoPath,
        url,
        async (_cwd, endpoint) =>
          JSON.stringify(
            endpoint.endsWith("/reviews")
              ? [
                  [
                    {
                      id: 28,
                      body: "",
                      state: "APPROVED",
                      submitted_at: "2026-07-03T00:00:00Z",
                    },
                  ],
                ]
              : [[]],
          ),
      );
    },
  };

  const submitted = await sync.syncGithubFeedback(deps);
  expect(
    submitted.emitted.filter(
      (event) =>
        event.type === "workflow_run.github_event" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(1);

  const unchanged = await sync.syncGithubFeedback(deps);
  expect(
    unchanged.emitted.filter(
      (event) =>
        event.type === "workflow_run.github_event" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(0);
});

test("isolates a GitHub failure to one PR and reports it visibly to the worker", async () => {
  const failed = await workflowGithubPull(201);
  const healthy = await workflowGithubPull(202);
  const result = await sync.syncGithubFeedback({
    async fetchFeedback(_repoPath, url) {
      if (url === failed.url) throw new Error("gh api failed: auth expired");
      if (url === healthy.url) {
        return [feedback({ kind: "review", id: 31, body: "please change" })];
      }
      return [];
    },
  });

  expect(result.failures).toEqual([
    {
      number: failed.number,
      github_number: 201,
      error: "gh api failed: auth expired",
    },
  ]);
  expect(
    result.emitted.some(
      (event) => JSON.parse(event.payload).number === healthy.number,
    ),
  ).toBe(true);
});

test("does not poll closed PRs or Workflow runs that are no longer active", async () => {
  const closed = await workflowGithubPull(301);
  svc.issues.update("me/proj", closed.number, { state: "closed" });
  const completed = await workflowGithubPull(302);
  S.updateWorkflowRun(completed.runId, { status: "completed" });
  const called: string[] = [];

  await sync.syncGithubFeedback({
    async fetchFeedback(_repoPath, url) {
      called.push(url);
      return [];
    },
  });

  expect(called).not.toContain(closed.url);
  expect(called).not.toContain(completed.url);
});
