import { describe, expect, it } from "vitest";
import { resolveMergeable } from "./mergeable.ts";

describe("resolveMergeable", () => {
  it("treats a diff-free PR (no commits) as not mergeable", () => {
    // no commits → not mergeable even though an empty tree never conflicts
    expect(
      resolveMergeable({
        hasCommits: false,
        conflict: false,
        reviewed: true,
        allTopicsPassed: true,
      }),
    ).toEqual({ mergeable: false, mergeable_state: "no_commits" });
  });

  it("ignores review/conflict signals when there are no commits", () => {
    expect(
      resolveMergeable({
        hasCommits: false,
        conflict: true,
        reviewed: false,
        allTopicsPassed: false,
      }),
    ).toEqual({ mergeable: false, mergeable_state: "no_commits" });
  });

  it("marks a conflicting PR as conflict", () => {
    expect(
      resolveMergeable({
        hasCommits: true,
        conflict: true,
        reviewed: true,
        allTopicsPassed: true,
      }),
    ).toEqual({ mergeable: false, mergeable_state: "conflict" });
  });

  it("blocks a PR with no reviews gathered yet (not clean by default)", () => {
    // reviews not yet gathered must not fall to clean just because nothing
    // requested changes (#427).
    expect(
      resolveMergeable({
        hasCommits: true,
        conflict: false,
        reviewed: false,
        allTopicsPassed: false,
      }),
    ).toEqual({ mergeable: false, mergeable_state: "blocked" });
  });

  it("blocks a PR with an unresolved REQUEST_CHANGES on a topic", () => {
    expect(
      resolveMergeable({
        hasCommits: true,
        conflict: false,
        reviewed: true,
        allTopicsPassed: false,
      }),
    ).toEqual({ mergeable: false, mergeable_state: "blocked" });
  });

  it("marks a PR with commits, no conflict, and all topics passed as clean/mergeable", () => {
    expect(
      resolveMergeable({
        hasCommits: true,
        conflict: false,
        reviewed: true,
        allTopicsPassed: true,
      }),
    ).toEqual({ mergeable: true, mergeable_state: "clean" });
  });
});
