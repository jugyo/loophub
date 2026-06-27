import { describe, expect, it } from "vitest";
import type { Issue, LinkedPull, PullRequest } from "@/api/types";
import {
  issueBadges,
  linkedPullStatus,
  mergeableBadge,
  pullBadges,
  reviewBadge,
  stateBadge,
  workingBadge,
} from "./badges";

function issue(partial: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    state: "open",
    title: "An issue",
    body: "",
    user: { login: "me" },
    labels: [],
    comments: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

function pull(partial: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 2,
    state: "open",
    title: "A PR",
    body: "",
    user: { login: "me" },
    head: { ref: "feat", sha: "a" },
    base: { ref: "main", sha: "b" },
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    review_state: null,
    changes_addressed_at: null,
    changes_addressed_by: null,
    merge_commit_sha: null,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("stateBadge", () => {
  it("marks open issues open and closed issues closed", () => {
    expect(stateBadge(issue({ state: "open" }), "issues")?.tone).toBe("open");
    expect(stateBadge(issue({ state: "closed" }), "issues")?.tone).toBe(
      "closed",
    );
  });

  it("hides the badge on open PRs but shows merged", () => {
    expect(
      stateBadge(pull({ state: "open", merged: false }), "pulls"),
    ).toBeNull();
    expect(stateBadge(pull({ merged: true }), "pulls")?.tone).toBe("merged");
  });
});

describe("reviewBadge", () => {
  it("returns null without a review state", () => {
    expect(reviewBadge(pull({ review_state: null }))).toBeNull();
  });

  it("humanizes the review state label", () => {
    const badge = reviewBadge(pull({ review_state: "CHANGES_REQUESTED" }));
    expect(badge).toEqual({
      tone: "review-changes",
      label: "changes requested",
    });
  });
});

describe("mergeableBadge", () => {
  it("flags a dirty open PR as conflict", () => {
    expect(mergeableBadge(pull({ mergeable_state: "dirty" }))?.tone).toBe(
      "conflict",
    );
  });

  it("marks a clean open PR as mergeable", () => {
    const badge = mergeableBadge(pull({ mergeable_state: "clean" }));
    expect(badge).toEqual({ tone: "mergeable", label: "mergeable" });
  });

  it("hides the muted states (unknown / no_commits / blocked)", () => {
    expect(mergeableBadge(pull({ mergeable_state: "unknown" }))).toBeNull();
    expect(mergeableBadge(pull({ mergeable_state: "no_commits" }))).toBeNull();
    expect(mergeableBadge(pull({ mergeable_state: "blocked" }))).toBeNull();
  });

  it("does not flag merged or non-open PRs", () => {
    expect(
      mergeableBadge(pull({ merged: true, mergeable_state: "dirty" })),
    ).toBeNull();
    expect(
      mergeableBadge(pull({ state: "closed", mergeable_state: "clean" })),
    ).toBeNull();
  });
});

describe("workingBadge", () => {
  it("shows a working badge on an open PR with a dirty worktree", () => {
    const badge = workingBadge(pull({ working: true }));
    expect(badge?.tone).toBe("working");
    expect(badge?.label).toBe("working");
  });

  it("does not show on a clean or worktree-less PR", () => {
    expect(workingBadge(pull({ working: false }))).toBeNull();
    expect(workingBadge(pull({}))).toBeNull();
  });

  it("does not show on merged or non-open PRs even if flagged", () => {
    expect(workingBadge(pull({ working: true, merged: true }))).toBeNull();
    expect(workingBadge(pull({ working: true, state: "closed" }))).toBeNull();
  });
});

describe("linkedPullStatus", () => {
  function linked(partial: Partial<LinkedPull> = {}): LinkedPull {
    return {
      number: 2,
      title: "A PR",
      state: "open",
      merged: false,
      ...partial,
    };
  }

  it("returns null for a plain open PR with no notable status", () => {
    expect(linkedPullStatus(linked())).toBeNull();
  });

  it("reports merged and closed states", () => {
    expect(linkedPullStatus(linked({ merged: true }))?.tone).toBe("merged");
    expect(linkedPullStatus(linked({ state: "closed" }))?.tone).toBe("closed");
  });

  it("prioritizes working over review and mergeable", () => {
    const status = linkedPullStatus(
      linked({
        working: true,
        review_state: "APPROVED",
        mergeable_state: "clean",
      }),
    );
    expect(status).toMatchObject({ tone: "working", label: "working" });
  });

  it("flags a dirty tree as conflict ahead of review", () => {
    expect(
      linkedPullStatus(
        linked({ mergeable_state: "dirty", review_state: "APPROVED" }),
      )?.tone,
    ).toBe("conflict");
  });

  it("maps review states to a single labelled word", () => {
    expect(
      linkedPullStatus(linked({ review_state: "CHANGES_REQUESTED" })),
    ).toEqual({ tone: "review-changes", label: "changes" });
    expect(linkedPullStatus(linked({ review_state: "STALE" }))?.label).toBe(
      "re-review",
    );
    expect(linkedPullStatus(linked({ review_state: "APPROVED" }))?.tone).toBe(
      "review-approved",
    );
  });

  it("falls back to mergeable for a clean PR without review", () => {
    expect(linkedPullStatus(linked({ mergeable_state: "clean" }))).toEqual({
      tone: "mergeable",
      label: "mergeable",
    });
  });

  it("does not derive working/conflict from a merged PR", () => {
    expect(
      linkedPullStatus(
        linked({ merged: true, working: true, mergeable_state: "dirty" }),
      )?.tone,
    ).toBe("merged");
  });
});

describe("issueBadges / pullBadges", () => {
  it("shows the state badge on a closed issue", () => {
    const badges = issueBadges(issue({ state: "closed" }));
    expect(badges.map((b) => b.tone)).toEqual(["closed"]);
  });

  it("collects review and conflict badges on a PR", () => {
    const badges = pullBadges(
      pull({
        review_state: "APPROVED",
        mergeable_state: "dirty",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual(["review-approved", "conflict"]);
  });

  it("shows the mergeable badge on a clean open PR", () => {
    const badges = pullBadges(pull({ mergeable_state: "clean" }));
    expect(badges.map((b) => b.tone)).toEqual(["mergeable"]);
  });

  it("hides approved and mergeable while working", () => {
    const badges = pullBadges(
      pull({
        working: true,
        review_state: "APPROVED",
        mergeable_state: "clean",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual(["working"]);
  });

  it("keeps non-approved review and conflict badges while working", () => {
    const badges = pullBadges(
      pull({
        working: true,
        review_state: "CHANGES_REQUESTED",
        mergeable_state: "dirty",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual([
      "working",
      "review-changes",
      "conflict",
    ]);
  });

  it("keeps the stale review badge while working", () => {
    const badges = pullBadges(
      pull({
        working: true,
        review_state: "STALE",
        mergeable_state: "unknown",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual(["working", "review-rereview"]);
  });
});
