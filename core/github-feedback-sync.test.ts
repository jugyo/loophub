import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

const HOME = mkdtempSync(join(tmpdir(), "lh-ghfeedback-sync-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let sync: typeof import("./github-sync.ts");
let github: typeof import("./github.ts");
let repoPath: string;
let workflowId: number;
type GithubPrFeedback = import("./github-feedback-sync.ts").GithubPrFeedback;
type GithubFeedbackDeps = import("./github.ts").GithubFeedbackDeps;

function syncFeedback(deps: GithubFeedbackDeps) {
  return sync.syncGithubPulls(["feedback"], deps);
}

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
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId,
  });
  return { number: pr.number, url, runId: run.id, parentSessionId };
}

function feedback(input: {
  kind: "issue_comment" | "review" | "review_comment";
  id: number;
  body: string;
  updatedAt?: string;
  createdAt?: string;
  authorLogin?: string | null;
  reviewState?: GithubPrFeedback["reviewState"];
  path?: string | null;
  line?: number | null;
  inReplyToId?: number | null;
  reviewId?: number | null;
  threadId?: string | null;
  threadResolved?: boolean | null;
}): GithubPrFeedback {
  return {
    path: null,
    line: null,
    inReplyToId: null,
    reviewId: null,
    threadId: null,
    threadResolved: null,
    ...input,
    updatedAt: input.updatedAt ?? "2026-07-01T00:00:00Z",
    createdAt: input.createdAt ?? input.updatedAt ?? "2026-07-01T00:00:00Z",
    authorLogin: input.authorLogin ?? null,
    reviewState: input.reviewState ?? null,
  };
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  sync = await import("./github-sync.ts");
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

test("emits one marked source event for aggregated GitHub feedback", async () => {
  const pull = await workflowGithubPull(101);
  const result = await syncFeedback({
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
    source_payload_version: 1,
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
  // No run-scoped twin follows: the marked source is what the run's subscription selects, and the
  // canonical `gh api` references on it are what the parent reads.
  expect(
    result.emitted.filter(
      (candidate) => candidate.type === "workflow_run.github_event",
    ),
  ).toEqual([]);
});

// #2500: the same sweep is what the PR timeline reads, so an observation carries who wrote the item,
// when it entered the conversation, a review's verdict, and a permalink built from the recorded PR
// URL — GitHub's own html_url is never trusted for it.
test("records what the PR timeline shows for each observed item", async () => {
  const pull = await workflowGithubPull(103);
  await syncFeedback({
    async fetchFeedback(_repoPath, url) {
      if (url !== pull.url) return [];
      return [
        feedback({
          kind: "issue_comment",
          id: 31,
          body: "conversation",
          authorLogin: "octocat",
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-01T06:00:00Z",
        }),
        feedback({
          kind: "review",
          id: 32,
          body: "looks good",
          authorLogin: "reviewer",
          reviewState: "approved",
        }),
        feedback({ kind: "review_comment", id: 33, body: "inline" }),
      ];
    },
  });

  const issueId = S.getIssue(S.getRepo("me", "proj")!.id, pull.number)!.id;
  expect(
    S.githubFeedbackObservations(issueId).map((row) => ({
      kind: row.kind,
      github_id: row.github_id,
      created_at: row.created_at,
      author_login: row.author_login,
      review_state: row.review_state,
      url: row.url,
    })),
  ).toEqual([
    {
      kind: "issue_comment",
      github_id: 31,
      created_at: "2026-07-01T00:00:00Z",
      author_login: "octocat",
      review_state: null,
      url: `${pull.url}#issuecomment-31`,
    },
    {
      kind: "review",
      github_id: 32,
      created_at: "2026-07-01T00:00:00Z",
      author_login: "reviewer",
      review_state: "approved",
      url: `${pull.url}#pullrequestreview-32`,
    },
    {
      kind: "review_comment",
      github_id: 33,
      created_at: "2026-07-01T00:00:00Z",
      author_login: null,
      review_state: null,
      url: `${pull.url}#discussion_r33`,
    },
  ]);
});

test("does not wake a Workflow run with no parent session, but still stores its feedback", async () => {
  // Same setup as workflowGithubPull but without parentSessionId: the agent event needs a parent
  // observer, while the GitHub PR view does not.
  const githubNumber = 150;
  const branch = `feedback-${githubNumber}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "feedback\n");
  git(["add", "-A"]);
  git(["commit", "-qm", branch]);
  git(["checkout", "-q", "main"]);
  const pr = await svc.pulls.create("me/proj", {
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
    costIncrementUsd: 10,
    costLimitUsd: 10,
  });

  const deps = {
    async fetchFeedback(_repoPath: string, urlArg: string) {
      return urlArg === url
        ? [feedback({ kind: "issue_comment", id: 25, body: "waiting" })]
        : [];
    },
  };

  const result = await syncFeedback(deps);
  expect(
    result.emitted.filter(
      (event) =>
        event.type === "pull_request.github_feedback" &&
        JSON.parse(event.payload).number === pr.number,
    ),
  ).toEqual([]);
  expect(
    S.githubFeedbackObservations(S.getIssue(repo.id, pr.number)!.id)[0]?.body,
  ).toBe("waiting");
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

  const first = await syncFeedback(deps);
  expect(
    first.emitted.filter(
      (event) =>
        event.type === "pull_request.github_feedback" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(1);

  // Calling the public sweep again models a worker restart: dedupe state must come from SQLite,
  // not process memory.
  const afterRestart = await syncFeedback(deps);
  expect(
    afterRestart.emitted.filter(
      (event) =>
        event.type === "pull_request.github_feedback" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(0);

  current = feedback({
    kind: "issue_comment",
    id: 21,
    body: "edited",
    updatedAt: "2026-07-02T00:00:00Z",
  });
  const edited = await syncFeedback(deps);
  expect(
    edited.emitted.filter(
      (event) =>
        event.type === "pull_request.github_feedback" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(1);
  const unchangedEdit = await syncFeedback(deps);
  expect(
    unchangedEdit.emitted.filter(
      (event) =>
        event.type === "pull_request.github_feedback" &&
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

  const pending = await syncFeedback(deps);
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
  const submitted = await syncFeedback(deps);
  expect(
    submitted.emitted.filter(
      (event) =>
        event.type === "pull_request.github_feedback" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(1);

  const unchanged = await syncFeedback(deps);
  expect(
    unchanged.emitted.filter(
      (event) =>
        event.type === "pull_request.github_feedback" &&
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

  const submitted = await syncFeedback(deps);
  expect(
    submitted.emitted.filter(
      (event) =>
        event.type === "pull_request.github_feedback" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(1);

  const unchanged = await syncFeedback(deps);
  expect(
    unchanged.emitted.filter(
      (event) =>
        event.type === "pull_request.github_feedback" &&
        JSON.parse(event.payload).number === pull.number,
    ),
  ).toHaveLength(0);
});

test("isolates a GitHub failure to one PR and reports it visibly to the worker", async () => {
  const failed = await workflowGithubPull(201);
  const healthy = await workflowGithubPull(202);
  const result = await syncFeedback({
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
      part: "feedback",
      error: "gh api failed: auth expired",
    },
  ]);
  expect(
    result.emitted.some(
      (event) => JSON.parse(event.payload).number === healthy.number,
    ),
  ).toBe(true);
});

test("stops polling closed PRs and keeps polling an open PR whose Workflow run finished", async () => {
  const closed = await workflowGithubPull(301);
  svc.issues.update("me/proj", closed.number, { state: "closed" });
  const completed = await workflowGithubPull(302);
  S.updateWorkflowRun(completed.runId, { status: "completed" });
  const called: string[] = [];

  await syncFeedback({
    async fetchFeedback(_repoPath, url) {
      called.push(url);
      return [];
    },
  });

  expect(called).not.toContain(closed.url);
  expect(called).toContain(completed.url);
});

async function linkedPull(githubNumber: number) {
  const branch = `linked-${githubNumber}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "linked\n");
  git(["add", "-A"]);
  git(["commit", "-qm", branch]);
  git(["checkout", "-q", "main"]);
  const pr = await svc.pulls.create("me/proj", { head: branch, base: "main" });
  const url = `https://github.com/upstream/proj/pull/${githubNumber}`;
  svc.pulls.recordGithubPull("me/proj", pr.number, {
    github_number: githubNumber,
    url,
  });
  return { number: pr.number, url };
}

function feedOnly(url: string, items: () => GithubPrFeedback[]) {
  return {
    async fetchFeedback(_repoPath: string, requested: string) {
      return requested === url ? items() : [];
    },
  };
}

function eventsFor(number: number, type: string) {
  const repo = S.getRepo("me", "proj")!;
  return S.listEvents(0, repo.id, 5000).filter(
    (event) =>
      event.type === type && JSON.parse(event.payload).number === number,
  );
}

test("a PR with no Workflow run is stored, announced without text, and does not wake an agent", async () => {
  const pull = await linkedPull(201);
  await syncFeedback(
    feedOnly(pull.url, () => [
      feedback({ kind: "issue_comment", id: 2011, body: "secret text" }),
    ]),
  );

  expect(eventsFor(pull.number, "pull_request.github_feedback")).toEqual([]);
  const [updated] = eventsFor(pull.number, "pull_request.github_data_updated");
  expect(updated!.payload).not.toContain("secret text");
  expect(
    svc.pulls.githubConversation("me/proj", pull.number).entries[0],
  ).toMatchObject({ kind: "comment", body: "secret text" });
});

test("feedback from before a Workflow started is announced to it once", async () => {
  const pull = await linkedPull(202);
  const deps = feedOnly(pull.url, () => [
    feedback({ kind: "issue_comment", id: 2021, body: "early" }),
  ]);
  await syncFeedback(deps);

  const repo = S.getRepo("me", "proj")!;
  S.createWorkflowRun({
    workflowId,
    repoId: repo.id,
    issueNumber: pull.number,
    prNumber: pull.number,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 10,
    costLimitUsd: 10,
    parentSessionId: "parent-202",
  });
  await syncFeedback(deps);
  await syncFeedback(deps);
  expect(eventsFor(pull.number, "pull_request.github_feedback")).toHaveLength(
    1,
  );
});

test("resolution, a dismissed verdict, and deletion reach the view without re-waking the agent", async () => {
  const pull = await workflowGithubPull(203);
  const repo = S.getRepo("me", "proj")!;
  const review = (state: GithubPrFeedback["reviewState"]) =>
    feedback({ kind: "review", id: 2031, body: "", reviewState: state });
  const inline = (resolved: boolean) =>
    feedback({
      kind: "review_comment",
      id: 2032,
      body: "fix this",
      reviewId: 2031,
      path: "a.ts",
      line: 4,
      threadId: "T_x",
      threadResolved: resolved,
    });
  const comment = feedback({ kind: "issue_comment", id: 2033, body: "bye" });

  let items = [review("changes_requested"), inline(false), comment];
  const deps = feedOnly(pull.url, () => items);
  await syncFeedback(deps);
  items = [review("dismissed"), inline(true)];
  await syncFeedback(deps);

  expect(eventsFor(pull.number, "pull_request.github_feedback")).toHaveLength(
    1,
  );
  expect(
    eventsFor(pull.number, "pull_request.github_data_updated"),
  ).toHaveLength(2);
  const conversation = svc.pulls.githubConversation("me/proj", pull.number);
  expect(conversation.unresolved_threads).toBe(0);
  expect(conversation.entries).toMatchObject([
    {
      kind: "review",
      state: "dismissed",
      threads: [{ id: 2032, path: "a.ts", line: 4, resolved: true }],
    },
  ]);
  // A deleted item is gone from the timeline too, whose link would now lead nowhere.
  const issueId = S.getIssue(repo.id, pull.number)!.id;
  expect(
    S.getGithubFeedbackObservation(issueId, "issue_comment", 2033),
  ).toBeNull();
});

test("a sweep backfills the body of a row observed before bodies were stored", async () => {
  const pull = await linkedPull(204);
  const repo = S.getRepo("me", "proj")!;
  const issueId = S.getIssue(repo.id, pull.number)!.id;
  const item = feedback({ kind: "issue_comment", id: 2041, body: "legacy" });
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update("legacy").digest("hex");
  S.saveGithubFeedbackObservation({
    issueId,
    kind: "issue_comment",
    githubId: 2041,
    contentHash: hash,
    updatedAt: item.updatedAt,
    notifiedHash: hash,
  });
  await syncFeedback(feedOnly(pull.url, () => [item]));
  expect(
    S.getGithubFeedbackObservation(issueId, "issue_comment", 2041)?.body,
  ).toBe("legacy");
  expect(eventsFor(pull.number, "pull_request.github_feedback")).toEqual([]);
});

test("the conversation hides an empty commented review and keeps its thread", async () => {
  const pull = await linkedPull(205);
  await syncFeedback(
    feedOnly(pull.url, () => [
      feedback({
        kind: "review",
        id: 2051,
        body: "",
        reviewState: "commented",
        createdAt: "2026-07-01T00:00:00Z",
      }),
      feedback({
        kind: "review",
        id: 2052,
        body: "",
        reviewState: "approved",
        createdAt: "2026-07-02T00:00:00Z",
      }),
      feedback({
        kind: "review_comment",
        id: 2053,
        body: "first",
        reviewId: 2051,
        createdAt: "2026-07-03T00:00:00Z",
        path: "b.ts",
      }),
      feedback({
        kind: "review_comment",
        id: 2054,
        body: "reply",
        reviewId: 2055,
        inReplyToId: 2053,
        createdAt: "2026-07-04T00:00:00Z",
        path: "b.ts",
      }),
    ]),
  );
  expect(
    svc.pulls.githubConversation("me/proj", pull.number).entries,
  ).toMatchObject([
    {
      kind: "thread",
      thread: { id: 2053, comments: [{ id: 2053 }, { id: 2054 }] },
    },
    { kind: "review", id: 2052, state: "approved", threads: [] },
  ]);
});

test("a relinked PR keeps the old ledger and shows only the current GitHub PR", async () => {
  const pull = await linkedPull(206);
  await syncFeedback(
    feedOnly(pull.url, () => [
      feedback({ kind: "issue_comment", id: 2061, body: "old link" }),
    ]),
  );
  svc.pulls.unlinkGithubPull("me/proj", pull.number);
  const nextUrl = "https://github.com/upstream/proj/pull/207";
  svc.pulls.recordGithubPull("me/proj", pull.number, {
    github_number: 207,
    url: nextUrl,
  });
  await syncFeedback(feedOnly(nextUrl, () => []));

  const repo = S.getRepo("me", "proj")!;
  const issueId = S.getIssue(repo.id, pull.number)!.id;
  expect(
    S.getGithubFeedbackObservation(issueId, "issue_comment", 2061),
  ).not.toBeNull();
  expect(svc.pulls.githubConversation("me/proj", pull.number).entries).toEqual(
    [],
  );
});
