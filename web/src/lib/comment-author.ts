// Author name the Web UI shows on a comment. Anything a human wrote reads as `@human`, whatever
// actor name it was stored under (#2129); agent and system posts keep the stored name.
// Pure + dependency-free so it is unit-testable.

import type { IssueComment } from "@/api/types";

/** Displayed author of every human post, replacing the stored actor name. */
export const HUMAN_AUTHOR = "human";

// Actor names that mean "the supervising human": the human CLI session registers as `me`
// (cli/context.ts), and the Web UI writes without registering a session, which core attributes to
// `unknown`. Only consulted where the wire carries no author type.
const HUMAN_ACTORS = new Set(["me", "unknown"]);

// Issue and PR comments carry an author type, so a human post is exactly `human`. Comments written
// before the Web UI recorded its posts as human keep their stored name: the actor they were saved
// under (`unknown`) also identifies genuine system posts, so there is nothing left to tell them
// apart by, and rewriting stored rows is out of scope.
export function commentAuthor(
  comment: Pick<IssueComment, "user" | "author_type">,
): string {
  return comment.author_type === "human" ? HUMAN_AUTHOR : comment.user.login;
}

// A diff conversation stores only an author name. Nothing writes one on behalf of the system —
// every message comes from an agent session (under that session's name) or from the human — so
// matching the human actor names is enough to tell the two apart.
export function diffFeedbackAuthor(author: string): string {
  return HUMAN_ACTORS.has(author) ? HUMAN_AUTHOR : author;
}
