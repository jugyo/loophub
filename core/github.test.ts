import { expect, test } from "vitest";
import {
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
      [{ id: 101, body: "conversation", updated_at: "2026-01-01T00:00:00Z" }],
      [{ id: 102, body: "page two", updated_at: "2026-01-02T00:00:00Z" }],
    ],
    "repos/upstream/project/pulls/9/reviews": [
      [
        { id: 201, body: "review body", submitted_at: "2026-01-03T00:00:00Z" },
        { id: 202, body: "", submitted_at: "2026-01-03T00:00:00Z" },
      ],
    ],
    "repos/upstream/project/pulls/9/comments": [
      [{ id: 301, body: "inline", updated_at: "2026-01-04T00:00:00Z" }],
    ],
  };

  const result = await fetchGithubPrFeedback(
    "/repo",
    "https://github.com/upstream/project/pull/9",
    async (_repoPath, endpoint) => {
      endpoints.push(endpoint);
      return JSON.stringify(responses[endpoint]);
    },
  );

  expect(endpoints).toEqual([
    "repos/upstream/project/issues/9/comments",
    "repos/upstream/project/pulls/9/reviews",
    "repos/upstream/project/pulls/9/comments",
  ]);
  expect(result).toEqual([
    {
      kind: "issue_comment",
      id: 101,
      body: "conversation",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      kind: "issue_comment",
      id: 102,
      body: "page two",
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      kind: "review",
      id: 201,
      body: "review body",
      updatedAt: "2026-01-03T00:00:00Z",
    },
    {
      kind: "review",
      id: 202,
      body: "",
      updatedAt: "2026-01-03T00:00:00Z",
    },
    {
      kind: "review_comment",
      id: 301,
      body: "inline",
      updatedAt: "2026-01-04T00:00:00Z",
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
  expect(submitted).toEqual([
    {
      kind: "review",
      id: 401,
      body: "same review body",
      updatedAt: "2026-01-05T00:00:00Z",
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
