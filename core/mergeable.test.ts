import { describe, expect, it } from "vitest";
import { resolveMergeable } from "./mergeable.ts";

describe("resolveMergeable", () => {
  it("treats a diff-free PR (no commits) as not mergeable", () => {
    // no commits → not mergeable even though an empty tree never conflicts
    expect(
      resolveMergeable({ hasCommits: false, conflict: false, approved: true }),
    ).toEqual({ mergeable: false, mergeable_state: "no_commits" });
  });

  it("ignores approval/conflict signals when there are no commits", () => {
    expect(
      resolveMergeable({ hasCommits: false, conflict: true, approved: false }),
    ).toEqual({ mergeable: false, mergeable_state: "no_commits" });
  });

  it("marks a conflicting PR as conflict", () => {
    expect(
      resolveMergeable({ hasCommits: true, conflict: true, approved: true }),
    ).toEqual({ mergeable: false, mergeable_state: "conflict" });
  });

  it("blocks an unapproved PR that has commits and merges cleanly", () => {
    expect(
      resolveMergeable({ hasCommits: true, conflict: false, approved: false }),
    ).toEqual({ mergeable: false, mergeable_state: "blocked" });
  });

  it("marks an approved PR with commits and no conflict as clean/mergeable", () => {
    expect(
      resolveMergeable({ hasCommits: true, conflict: false, approved: true }),
    ).toEqual({ mergeable: true, mergeable_state: "clean" });
  });
});
