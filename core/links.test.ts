import { expect, test } from "#loophub-test";
import { pullCommentPermalink } from "./links.ts";

test("pullCommentPermalink opens the PR screen on the comment's anchor", () => {
  expect(pullCommentPermalink({ owner: "me", name: "proj" }, 30, 9)).toBe(
    "/r/me/proj/pulls/30#comment-9",
  );
});
