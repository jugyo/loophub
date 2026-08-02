// Author name the Web UI shows on a comment. Anything a human wrote reads as `@human`, whatever
// actor name it was stored under (#2129); agent and system posts keep the stored name.
// Pure + dependency-free so it is unit-testable.

import type { IssueComment } from "@/api/types";

/** Displayed author of every human post, replacing the stored actor name. */
export const HUMAN_AUTHOR = "human";

// Issue and PR comments carry an author type, so a human post is exactly `human`. Comments written
// before the Web UI recorded its posts as human keep their stored name: the actor they were saved
// under (`unknown`) also identifies genuine system posts, so there is nothing left to tell them
// apart by, and rewriting stored rows is out of scope.
export function commentAuthor(
  comment: Pick<IssueComment, "user" | "author_type">,
): string {
  return comment.author_type === "human" ? HUMAN_AUTHOR : comment.user.login;
}
