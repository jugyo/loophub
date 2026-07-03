import { expect, test } from "vitest";
import { parseGithubIssueUrl } from "./github.ts";

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
