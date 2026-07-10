import { describe, expect, it } from "vitest";
import type { Issue, LinkedPull, PullRequest } from "@/api/types";
import {
  costStoppedBadge,
  draftBadge,
  issueBadges,
  issueBuildButtonState,
  linkedPullPillTone,
  linkedPullStateBadge,
  linkedPullStatus,
  linkedPullWordTone,
  mergeableBadge,
  primaryLinkedPull,
  pullBadges,
  pullDetailBadges,
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
    target_branch: null,
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
    base_sha: "b",
    merged: false,
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    review_state: null,
    changes_addressed_at: null,
    changes_addressed_by: null,
    merge_commit_sha: null,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    working: false,
    labels: [],
    comments: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    linked_issue: null,
    worktree_path: null,
    cost_stopped: false,
    merge_mode: "merge",
    github_pull: null,
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
      label: "changes",
    });
  });
});

describe("mergeableBadge", () => {
  it("flags a conflicting open PR as conflict", () => {
    expect(mergeableBadge(pull({ mergeable_state: "conflict" }))?.tone).toBe(
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
      mergeableBadge(pull({ merged: true, mergeable_state: "conflict" })),
    ).toBeNull();
    expect(
      mergeableBadge(pull({ state: "closed", mergeable_state: "clean" })),
    ).toBeNull();
  });
});

describe("workingBadge", () => {
  it("shows a working badge on an open PR with a live agent", () => {
    const badge = workingBadge(pull({}), { agentWorking: true });
    expect(badge?.tone).toBe("working");
    expect(badge?.label).toBe("working");
  });

  it("does not show for a dirty worktree alone — signal B only (#1125)", () => {
    // A dirty worktree no longer reads "working"; only a live agent does.
    expect(workingBadge(pull({ working: true }))).toBeNull();
    expect(workingBadge(pull({ working: false }))).toBeNull();
    expect(workingBadge(pull({}))).toBeNull();
  });

  it("does not show on merged or non-open PRs even with a live agent", () => {
    expect(
      workingBadge(pull({ merged: true }), { agentWorking: true }),
    ).toBeNull();
    expect(
      workingBadge(pull({ state: "closed" }), { agentWorking: true }),
    ).toBeNull();
  });
});

describe("draftBadge (#413)", () => {
  it("shows a draft badge on an open, unmerged WIP PR", () => {
    const badge = draftBadge(pull({ draft: true }));
    expect(badge?.tone).toBe("draft");
    expect(badge?.label).toBe("draft");
  });

  it("does not show once the PR is ready", () => {
    expect(draftBadge(pull({ draft: false }))).toBeNull();
  });

  it("does not show on merged or closed PRs even if flagged", () => {
    expect(draftBadge(pull({ draft: true, merged: true }))).toBeNull();
    expect(draftBadge(pull({ draft: true, state: "closed" }))).toBeNull();
  });

  it("is included first in pullBadges / pullDetailBadges for a draft PR", () => {
    expect(pullBadges(pull({ draft: true }))[0]?.tone).toBe("draft");
    expect(pullDetailBadges(pull({ draft: true }))[0]?.tone).toBe("draft");
  });
});

describe("costStoppedBadge (#863)", () => {
  it("shows a cost-stopped badge on an open PR with the flag set", () => {
    const badge = costStoppedBadge(pull({ cost_stopped: true }));
    expect(badge?.tone).toBe("cost-stopped");
    expect(badge?.label).toBe("over budget");
    // AC: the tooltip conveys that the stop was due to the cost limit.
    expect(badge?.title).toMatch(/cost limit/i);
  });

  it("does not show when the PR was never stopped", () => {
    expect(costStoppedBadge(pull({ cost_stopped: false }))).toBeNull();
    // Absent flag (older server) reads as not stopped.
    expect(costStoppedBadge(pull())).toBeNull();
  });

  it("does not show on merged or closed PRs even if flagged", () => {
    expect(
      costStoppedBadge(pull({ cost_stopped: true, merged: true })),
    ).toBeNull();
    expect(
      costStoppedBadge(pull({ cost_stopped: true, state: "closed" })),
    ).toBeNull();
  });

  it("is included first in pullBadges / pullDetailBadges for a stopped PR", () => {
    expect(pullBadges(pull({ cost_stopped: true }))[0]?.tone).toBe(
      "cost-stopped",
    );
    expect(pullDetailBadges(pull({ cost_stopped: true }))[0]?.tone).toBe(
      "cost-stopped",
    );
  });

  it("does not add the badge to a non-stopped PR's badge list", () => {
    expect(
      pullBadges(pull({ cost_stopped: false })).some(
        (b) => b.tone === "cost-stopped",
      ),
    ).toBe(false);
  });
});

describe("linkedPullStatus", () => {
  function linked(partial: Partial<LinkedPull> = {}): LinkedPull {
    return {
      number: 2,
      title: "A PR",
      state: "open",
      merged: false,
      html_url: "/pulls/2",
      github_pull: null,
      cost_stopped: false,
      ...partial,
    };
  }

  it("returns null for an idle open PR with no decided status", () => {
    // No live agent and nothing decided (summary path with no fields, or a
    // computed-but-undecided fresh PR): idle, so the row falls back to its
    // lifecycle pill rather than reading "working" (#1125).
    expect(linkedPullStatus(linked())).toBeNull();
    for (const mergeable_state of [
      "blocked",
      "unknown",
      "no_commits",
    ] as const) {
      expect(linkedPullStatus(linked({ mergeable_state }))).toBeNull();
    }
  });

  it("does not read a dirty worktree alone as working (#1125)", () => {
    // Signal A (pull.working) no longer produces "working" — only a live agent
    // does. An idle PR whose session left uncommitted changes is idle, matching
    // the PR detail page (pullDetailBadges).
    expect(linkedPullStatus(linked({ working: true }))).toBeNull();
    expect(
      linkedPullStatus(linked({ working: true, mergeable_state: "blocked" })),
    ).toBeNull();
    // A live agent still reads "working".
    expect(
      linkedPullStatus(linked({ working: true }), { agentWorking: true })?.tone,
    ).toBe("working");
  });

  it("reports merged and closed states", () => {
    expect(linkedPullStatus(linked({ merged: true }))?.tone).toBe("merged");
    expect(linkedPullStatus(linked({ state: "closed" }))?.tone).toBe("closed");
  });

  it("lets conflict and changes win over working (mirrors pullBadges)", () => {
    expect(
      linkedPullStatus(linked({ working: true, mergeable_state: "conflict" }))
        ?.tone,
    ).toBe("conflict");
    expect(
      linkedPullStatus(
        linked({ working: true, review_state: "CHANGES_REQUESTED" }),
      )?.tone,
    ).toBe("review-changes");
  });

  it("reports passed over working — passed is the PR's real state (#419)", () => {
    // A decided review state outranks the transient worktree-dirty cue, so the
    // issue list reads "passed", matching the PR detail page, instead of
    // masking a passed PR as "working".
    expect(
      linkedPullStatus(
        linked({
          working: true,
          review_state: "PASSED",
          mergeable_state: "clean",
        }),
      )?.tone,
    ).toBe("review-passed");
    expect(
      linkedPullStatus(
        linked({ review_state: "PASSED", mergeable_state: "clean" }),
      )?.tone,
    ).toBe("review-passed");
  });

  it("reports herdr agent working over review-result statuses", () => {
    expect(
      linkedPullStatus(
        linked({ review_state: "PASSED", mergeable_state: "clean" }),
        { agentWorking: true },
      )?.tone,
    ).toBe("working");
    expect(
      linkedPullStatus(
        linked({ review_state: "CHANGES_REQUESTED", mergeable_state: "clean" }),
        { agentWorking: true },
      )?.tone,
    ).toBe("working");
    expect(
      linkedPullStatus(
        linked({ review_state: "STALE", mergeable_state: "blocked" }),
        { agentWorking: true },
      )?.tone,
    ).toBe("working");
    expect(
      linkedPullStatus(
        linked({ review_state: "COMMENTED", mergeable_state: "clean" }),
        { agentWorking: true },
      )?.tone,
    ).toBe("working");
  });

  it("keeps merged, closed, and conflict ahead of herdr agent working", () => {
    expect(
      linkedPullStatus(linked({ merged: true }), { agentWorking: true })?.tone,
    ).toBe("merged");
    expect(
      linkedPullStatus(linked({ state: "closed" }), { agentWorking: true })
        ?.tone,
    ).toBe("closed");
    expect(
      linkedPullStatus(
        linked({ mergeable_state: "conflict", review_state: "PASSED" }),
        { agentWorking: true },
      )?.tone,
    ).toBe("conflict");
  });

  it("flags a conflict ahead of review", () => {
    expect(
      linkedPullStatus(
        linked({ mergeable_state: "conflict", review_state: "PASSED" }),
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
    expect(linkedPullStatus(linked({ review_state: "COMMENTED" }))?.tone).toBe(
      "review-commented",
    );
  });

  it("does not derive working/conflict from a merged PR", () => {
    expect(
      linkedPullStatus(
        linked({ merged: true, working: true, mergeable_state: "conflict" }),
      )?.tone,
    ).toBe("merged");
  });
});

describe("linkedPullStateBadge (#269 detail summary)", () => {
  function linked(partial: Partial<LinkedPull> = {}): LinkedPull {
    return {
      number: 2,
      title: "A PR",
      state: "open",
      merged: false,
      html_url: "/pulls/2",
      github_pull: null,
      cost_stopped: false,
      ...partial,
    };
  }

  it("always returns a badge from state + merged alone", () => {
    expect(linkedPullStateBadge(linked())).toEqual({
      tone: "open",
      label: "open",
    });
    expect(linkedPullStateBadge(linked({ merged: true }))).toEqual({
      tone: "merged",
      label: "merged",
    });
    expect(linkedPullStateBadge(linked({ state: "closed" }))).toEqual({
      tone: "closed",
      label: "closed",
    });
  });

  it("treats a merged PR as merged even when state is closed", () => {
    expect(
      linkedPullStateBadge(linked({ state: "closed", merged: true })).tone,
    ).toBe("merged");
  });
});

describe("linkedPullPillTone (lifecycle axis)", () => {
  function linked(partial: Partial<LinkedPull> = {}): LinkedPull {
    return {
      number: 2,
      title: "A PR",
      state: "open",
      merged: false,
      html_url: "/pulls/2",
      github_pull: null,
      cost_stopped: false,
      ...partial,
    };
  }

  it("colours the pill by lifecycle, not status", () => {
    expect(linkedPullPillTone(linked({ merged: true }))).toBe("merged");
    expect(linkedPullPillTone(linked({ state: "closed" }))).toBe("closed");
    // open stays green regardless of conflict/working status on the word axis.
    expect(linkedPullPillTone(linked({ mergeable_state: "conflict" }))).toBe(
      "open",
    );
    expect(linkedPullPillTone(linked({ working: true }))).toBe("open");
  });
});

describe("linkedPullWordTone (state-specific colour axis)", () => {
  it("paints conflict and changes red (danger)", () => {
    expect(linkedPullWordTone("conflict")).toBe("danger");
    expect(linkedPullWordTone("review-changes")).toBe("danger");
  });

  it("paints passed green (ready) and merged purple (done)", () => {
    expect(linkedPullWordTone("review-passed")).toBe("ready");
    expect(linkedPullWordTone("merged")).toBe("done");
  });

  it("leaves every other status muted (grey)", () => {
    for (const tone of [
      "working",
      "review-rereview",
      "review-commented",
      "closed",
    ] as const) {
      expect(linkedPullWordTone(tone)).toBe("muted");
    }
  });
});

describe("primaryLinkedPull (#598)", () => {
  function linked(partial: Partial<LinkedPull> = {}): LinkedPull {
    return {
      number: 2,
      title: "A PR",
      state: "open",
      merged: false,
      html_url: "/pulls/2",
      github_pull: null,
      cost_stopped: false,
      ...partial,
    };
  }

  it("returns null when no PR is linked", () => {
    expect(primaryLinkedPull(issue())).toBeNull();
  });

  it("prefers linked_pull_requests[0] over the singular field", () => {
    const first = linked({ number: 11 });
    const second = linked({ number: 12 });
    expect(
      primaryLinkedPull(
        issue({
          linked_pull_request: second,
          linked_pull_requests: [first, second],
        }),
      ),
    ).toBe(first);
  });

  it("falls back to the singular field when the array is absent", () => {
    const solo = linked({ number: 13 });
    expect(primaryLinkedPull(issue({ linked_pull_request: solo }))).toBe(solo);
  });
});

describe("issueBuildButtonState (#598)", () => {
  function linked(partial: Partial<LinkedPull> = {}): LinkedPull {
    return {
      number: 2,
      title: "A PR",
      state: "open",
      merged: false,
      html_url: "/pulls/2",
      github_pull: null,
      cost_stopped: false,
      ...partial,
    };
  }

  it("is 'build' when no PR is linked", () => {
    expect(issueBuildButtonState(issue())).toBe("build");
  });

  it("is 'building' while the primary linked PR is open and unmerged", () => {
    expect(
      issueBuildButtonState(
        issue({ linked_pull_request: linked({ state: "open" }) }),
      ),
    ).toBe("building");
  });

  it("is 'merged' once the primary linked PR merged", () => {
    expect(
      issueBuildButtonState(
        issue({
          linked_pull_request: linked({ state: "closed", merged: true }),
        }),
      ),
    ).toBe("merged");
  });

  it("is 'build' when the primary linked PR closed unmerged (rejected)", () => {
    expect(
      issueBuildButtonState(
        issue({
          linked_pull_request: linked({ state: "closed", merged: false }),
        }),
      ),
    ).toBe("build");
  });

  it("judges by the most relevant PR (index 0) when several are linked", () => {
    expect(
      issueBuildButtonState(
        issue({
          linked_pull_requests: [
            linked({ number: 1, state: "closed", merged: false }),
            linked({ number: 2, state: "open", merged: false }),
          ],
        }),
      ),
    ).toBe("build");
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
        review_state: "PASSED",
        mergeable_state: "conflict",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual(["review-passed", "conflict"]);
  });

  it("shows the mergeable badge on a clean open PR", () => {
    const badges = pullBadges(pull({ mergeable_state: "clean" }));
    expect(badges.map((b) => b.tone)).toEqual(["mergeable"]);
  });

  it("does not emit a working badge for a dirty worktree alone (#1125)", () => {
    // Signal A no longer reads "working" on the list either — it matches the PR
    // detail page (pullDetailBadges), so review/mergeable are shown normally.
    const badges = pullBadges(
      pull({
        working: true,
        review_state: "PASSED",
        mergeable_state: "clean",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual(["review-passed", "mergeable"]);
  });

  it("keeps review and conflict badges for a dirty worktree (#1125)", () => {
    const badges = pullBadges(
      pull({
        working: true,
        review_state: "CHANGES_REQUESTED",
        mergeable_state: "conflict",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual(["review-changes", "conflict"]);
  });

  it("suppresses review-result and mergeable badges only while a herdr agent is working", () => {
    const badges = pullBadges(
      pull({
        working: true,
        review_state: "PASSED",
        mergeable_state: "clean",
      }),
      { agentWorking: true },
    );
    expect(badges.map((b) => b.tone)).toEqual(["working"]);
  });

  it("suppresses review-result badges while a herdr agent is working", () => {
    const badges = pullBadges(
      pull({
        review_state: "CHANGES_REQUESTED",
        mergeable_state: "clean",
      }),
      { agentWorking: true },
    );
    expect(badges.map((b) => b.tone)).toEqual(["working"]);
  });

  it("keeps conflict visible while a herdr agent is working", () => {
    const badges = pullBadges(
      pull({
        review_state: "PASSED",
        mergeable_state: "conflict",
      }),
      { agentWorking: true },
    );
    expect(badges.map((b) => b.tone)).toEqual(["working", "conflict"]);
  });
});

describe("pullDetailBadges", () => {
  it("shows passed and mergeable on an open PR (no working suppression)", () => {
    const badges = pullDetailBadges(
      pull({ review_state: "PASSED", mergeable_state: "clean" }),
    );
    expect(badges.map((b) => b.tone)).toEqual(["review-passed", "mergeable"]);
  });

  it("still shows passed and mergeable while the worktree is working (#386)", () => {
    // pullBadges hides these while working; pullDetailBadges does not, so the
    // terminal header matches the PR detail page.
    const badges = pullDetailBadges(
      pull({
        working: true,
        review_state: "PASSED",
        mergeable_state: "clean",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual(["review-passed", "mergeable"]);
  });

  it("does not emit a working badge for dirty-worktree working alone", () => {
    const badges = pullDetailBadges(pull({ working: true }));
    expect(badges.map((b) => b.tone)).not.toContain("working");
  });

  it("shows working and suppresses review results while a herdr agent is working", () => {
    const badges = pullDetailBadges(
      pull({ review_state: "PASSED", mergeable_state: "clean" }),
      { agentWorking: true },
    );
    expect(badges.map((b) => b.tone)).toEqual(["working"]);
  });

  it("keeps conflict visible in detail while a herdr agent is working", () => {
    const badges = pullDetailBadges(
      pull({ review_state: "PASSED", mergeable_state: "conflict" }),
      { agentWorking: true },
    );
    expect(badges.map((b) => b.tone)).toEqual(["working", "conflict"]);
  });

  it("shows merged state and omits review/mergeable on a merged PR", () => {
    const badges = pullDetailBadges(
      pull({
        merged: true,
        review_state: "PASSED",
        mergeable_state: "clean",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual(["merged"]);
  });

  it("merged and closed states outrank a herdr working agent", () => {
    expect(
      pullDetailBadges(pull({ merged: true }), { agentWorking: true }).map(
        (b) => b.tone,
      ),
    ).toEqual(["merged"]);
    expect(
      pullDetailBadges(pull({ state: "closed" }), { agentWorking: true }).map(
        (b) => b.tone,
      ),
    ).toEqual(["closed"]);
  });
});
