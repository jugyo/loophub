import { expect, test } from "#loophub-test";
import {
  failedLogExcerpt,
  fetchGithubPrCheckRuns,
  fetchGithubPrCommitShas,
  fetchGithubPrFeedback,
  parseGithubIssueUrl,
  parseGithubPullUrl,
} from "./github.ts";

// #614: parseGithubIssueUrl is pure (no gh/network) — the service layer validates the input before
// spending a fetch, so these cases pin the accepted/rejected URL shapes.
test("parses a canonical GitHub issue URL", () => {
  expect(
    parseGithubIssueUrl("https://github.com/jugyo/loophub/issues/614"),
  ).toEqual({ owner: "jugyo", repo: "loophub", number: 614 });
});

test("tolerates a trailing slash, query, fragment, and surrounding whitespace", () => {
  expect(parseGithubIssueUrl("  https://github.com/o/r/issues/7/  ")).toEqual({
    owner: "o",
    repo: "r",
    number: 7,
  });
  expect(
    parseGithubIssueUrl("https://github.com/o/r/issues/7?foo=bar"),
  ).toEqual({ owner: "o", repo: "r", number: 7 });
  expect(
    parseGithubIssueUrl("https://github.com/o/r/issues/7#issuecomment-99"),
  ).toEqual({ owner: "o", repo: "r", number: 7 });
});

test("accepts the www.github.com host and http scheme", () => {
  expect(parseGithubIssueUrl("http://www.github.com/o/r/issues/1")).toEqual({
    owner: "o",
    repo: "r",
    number: 1,
  });
});

test("rejects non-issue and non-GitHub URLs", () => {
  // A pull URL is intentionally rejected — importing a PR as an issue is out of scope.
  expect(parseGithubIssueUrl("https://github.com/o/r/pull/7")).toBeNull();
  expect(parseGithubIssueUrl("https://github.com/o/r")).toBeNull();
  expect(parseGithubIssueUrl("https://gitlab.com/o/r/issues/7")).toBeNull();
  expect(parseGithubIssueUrl("https://evil.example/o/r/issues/7")).toBeNull();
  // A lookalike host must not pass the exact-host check.
  expect(
    parseGithubIssueUrl("https://github.com.evil.com/o/r/issues/7"),
  ).toBeNull();
  expect(parseGithubIssueUrl("not a url")).toBeNull();
  expect(parseGithubIssueUrl("")).toBeNull();
  // Non-positive / non-numeric issue numbers.
  expect(parseGithubIssueUrl("https://github.com/o/r/issues/0")).toBeNull();
  expect(parseGithubIssueUrl("https://github.com/o/r/issues/abc")).toBeNull();
});

test("fetches and normalizes conversation comments, review bodies, and inline comments", async () => {
  const endpoints: string[] = [];
  const responses: Record<string, unknown> = {
    "repos/upstream/project/issues/9/comments": [
      [
        {
          id: 101,
          body: "conversation",
          user: { login: "octocat" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T09:00:00Z",
        },
      ],
      [{ id: 102, body: "page two", updated_at: "2026-01-02T00:00:00Z" }],
    ],
    "repos/upstream/project/pulls/9/reviews": [
      [
        {
          id: 201,
          body: "review body",
          state: "APPROVED",
          user: { login: "reviewer" },
          submitted_at: "2026-01-03T00:00:00Z",
        },
        { id: 202, body: "", submitted_at: "2026-01-03T00:00:00Z" },
      ],
    ],
    "repos/upstream/project/pulls/9/comments": [
      [
        {
          id: 301,
          body: "inline",
          user: { login: "reviewer" },
          updated_at: "2026-01-04T00:00:00Z",
        },
      ],
    ],
  };

  const result = await fetchGithubPrFeedback(
    "/repo",
    "https://github.com/upstream/project/pull/9",
    async (_repoPath, endpoint) => {
      endpoints.push(endpoint);
      return JSON.stringify(responses[endpoint] ?? []);
    },
  );

  expect(endpoints).toEqual([
    "repos/upstream/project/issues/9/comments",
    "repos/upstream/project/pulls/9/reviews",
    "repos/upstream/project/pulls/9/comments",
    "graphql",
  ]);
  // #2500: alongside the digest inputs, normalization keeps what the PR timeline shows — the author,
  // when the item entered the conversation (distinct from its last edit) and a review's verdict.
  // Each is null when GitHub's payload does not carry it, rather than dropping the item.
  expect(result).toMatchObject([
    {
      kind: "issue_comment",
      id: 101,
      body: "conversation",
      updatedAt: "2026-01-01T09:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
      authorLogin: "octocat",
      reviewState: null,
    },
    {
      kind: "issue_comment",
      id: 102,
      body: "page two",
      updatedAt: "2026-01-02T00:00:00Z",
      createdAt: "2026-01-02T00:00:00Z",
      authorLogin: null,
      reviewState: null,
    },
    {
      kind: "review",
      id: 201,
      body: "review body",
      updatedAt: "2026-01-03T00:00:00Z",
      // A review has no created_at; submitted_at is when it entered the conversation.
      createdAt: "2026-01-03T00:00:00Z",
      authorLogin: "reviewer",
      reviewState: "approved",
    },
    {
      kind: "review",
      id: 202,
      body: "",
      updatedAt: "2026-01-03T00:00:00Z",
      createdAt: "2026-01-03T00:00:00Z",
      authorLogin: null,
      reviewState: null,
    },
    {
      kind: "review_comment",
      id: 301,
      body: "inline",
      updatedAt: "2026-01-04T00:00:00Z",
      createdAt: "2026-01-04T00:00:00Z",
      authorLogin: "reviewer",
      reviewState: null,
    },
  ]);
});

test("ignores a pending review until the same review is submitted", async () => {
  let review: Record<string, unknown> = {
    id: 401,
    body: "same review body",
    state: "PENDING",
    submitted_at: null,
  };
  const api = async (_repoPath: string, endpoint: string) =>
    JSON.stringify(endpoint.endsWith("/reviews") ? [[review]] : [[]]);

  const pending = await fetchGithubPrFeedback(
    "/repo",
    "https://github.com/upstream/project/pull/9",
    api,
  );
  expect(pending).toEqual([]);

  review = {
    id: 401,
    body: "same review body",
    state: "COMMENTED",
    submitted_at: "2026-01-05T00:00:00Z",
  };
  const submitted = await fetchGithubPrFeedback(
    "/repo",
    "https://github.com/upstream/project/pull/9",
    api,
  );
  expect(submitted).toMatchObject([
    {
      kind: "review",
      id: 401,
      body: "same review body",
      updatedAt: "2026-01-05T00:00:00Z",
      createdAt: "2026-01-05T00:00:00Z",
      authorLogin: null,
      reviewState: "commented",
    },
  ]);
});

test("parses only canonical GitHub pull URLs", () => {
  expect(parseGithubPullUrl("https://github.com/o/r/pull/42")).toEqual({
    owner: "o",
    repo: "r",
    number: 42,
  });
  expect(parseGithubPullUrl("https://github.com/o/r/pull/42/files")).toBeNull();
  expect(parseGithubPullUrl("https://github.com.evil/o/r/pull/42")).toBeNull();
});

test("PRコミットSHAを全ページから取得する", async () => {
  const pageOne = Array.from({ length: 100 }, (_, index) => ({
    sha: `sha-${index}`,
  }));
  const pageTwo = [{ sha: "sha-100" }, { sha: 101 }, null];
  let endpoint = "";

  const result = await fetchGithubPrCommitShas(
    "/repo",
    "https://github.com/upstream/project/pull/9",
    async (_repoPath, requestedEndpoint) => {
      endpoint = requestedEndpoint;
      return JSON.stringify([pageOne, pageTwo]);
    },
  );

  expect(endpoint).toBe("repos/upstream/project/pulls/9/commits");
  expect(result).toHaveLength(101);
  expect(result[0]).toBe("sha-0");
  expect(result.at(-1)).toBe("sha-100");
});

test("joins review-thread resolution onto every comment of the thread", async () => {
  const inline = [
    {
      id: 1,
      body: "root",
      path: "a.ts",
      line: null,
      original_line: 12,
      pull_request_review_id: 50,
    },
    { id: 2, body: "reply", path: "a.ts", line: 13, in_reply_to_id: 1 },
    { id: 3, body: "other", path: "b.ts", line: 1 },
  ];
  const threads = [
    {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "T_1",
                  isResolved: true,
                  comments: { nodes: [{ databaseId: 1 }] },
                },
              ],
            },
          },
        },
      },
    },
  ];
  let fields: string[] = [];
  const result = await fetchGithubPrFeedback(
    "/repo",
    "https://github.com/upstream/project/pull/9",
    async (_repoPath, endpoint, requestedFields) => {
      if (endpoint === "graphql") {
        fields = requestedFields ?? [];
        return JSON.stringify(threads);
      }
      return JSON.stringify(
        endpoint.endsWith("/pulls/9/comments") ? [inline] : [],
      );
    },
  );

  expect(fields).toContain("number=9");
  expect(result).toMatchObject([
    {
      id: 1,
      path: "a.ts",
      line: 12,
      reviewId: 50,
      threadId: "T_1",
      threadResolved: true,
    },
    { id: 2, inReplyToId: 1, threadId: "T_1", threadResolved: true },
    { id: 3, threadId: null, threadResolved: null },
  ]);
});

test("a failed review-thread lookup fails the fetch rather than returning partial state", async () => {
  await expect(
    fetchGithubPrFeedback(
      "/repo",
      "https://github.com/upstream/project/pull/9",
      async (_repoPath, endpoint) => {
        if (endpoint === "graphql") throw new Error("gh api failed");
        return "[]";
      },
    ),
  ).rejects.toThrow("gh api failed");
});

test("normalizes check runs, keeping only http(s) URLs", async () => {
  const page = {
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          databaseId: 5,
                          name: "test",
                          status: "COMPLETED",
                          conclusion: "FAILURE",
                          startedAt: "2026-01-01T00:00:00Z",
                          completedAt: "2026-01-01T00:01:00Z",
                          detailsUrl: "javascript:alert(1)",
                          isRequired: true,
                          checkSuite: {
                            workflowRun: { workflow: { name: "CI" } },
                          },
                        },
                        {
                          __typename: "CheckRun",
                          databaseId: 6,
                          name: "lint",
                          status: "IN_PROGRESS",
                          conclusion: null,
                          startedAt: "2026-01-01T00:00:00Z",
                          completedAt: null,
                          detailsUrl: "https://github.com/o/r/runs/6",
                          isRequired: false,
                          checkSuite: { workflowRun: null },
                        },
                        { __typename: "StatusContext", context: "other" },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
  expect(
    await fetchGithubPrCheckRuns(
      "/repo",
      "https://github.com/o/r/pull/9",
      async () => JSON.stringify([page]),
    ),
  ).toEqual([
    {
      jobId: 5,
      name: "test",
      workflow: "CI",
      state: "failure",
      required: true,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z",
      url: null,
    },
    {
      jobId: 6,
      name: "lint",
      workflow: null,
      state: "pending",
      required: false,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: null,
      url: "https://github.com/o/r/runs/6",
    },
  ]);
});

test("a failed log excerpt strips the job/step columns and color codes and keeps the end", () => {
  const lines = Array.from(
    { length: 400 },
    (_, index) => `build\tRun tests\t\u001b[31mline ${index}\u001b[0m`,
  );
  const excerpt = failedLogExcerpt(lines.join("\n"));
  expect(excerpt.split("\n")).toHaveLength(300);
  expect(excerpt.endsWith("line 399")).toBe(true);
  expect(excerpt).not.toContain("Run tests");
  expect(excerpt).not.toContain("\u001b");
});
