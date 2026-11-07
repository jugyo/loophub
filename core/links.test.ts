import { expect, test } from "#loophub-test";
import { parseClosingIssueNumber, pullCommentPermalink } from "./links.ts";

test("parseClosingIssueNumber detects GitHub-style keywords", () => {
  expect(parseClosingIssueNumber("closes #12")).toBe(12);
  expect(parseClosingIssueNumber("Fixes #3")).toBe(3);
  expect(parseClosingIssueNumber("This PR resolves #99 and more")).toBe(99);
  expect(parseClosingIssueNumber("no link here")).toBe(null);
});

test("pullCommentPermalink opens the PR screen on the comment's anchor", () => {
  expect(pullCommentPermalink({ owner: "me", name: "proj" }, 30, 9)).toBe(
    "/r/me/proj/pulls/30#comment-9",
  );
});
