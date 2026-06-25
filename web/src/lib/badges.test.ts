import { describe, expect, it } from "vitest";
import type { AgentSession, Issue, PullRequest } from "@/api/types";
import {
  assigneeBadge,
  issueBadges,
  mergeableBadge,
  pullBadges,
  reviewBadge,
  stateBadge,
} from "./badges";

const session: AgentSession = {
  session_id: "sid-1",
  agent: "impl-bot",
  session: "run-1",
  name: null,
};

function issue(partial: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    state: "open",
    title: "An issue",
    body: "",
    user: { login: "me" },
    assignee: null,
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
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("assigneeBadge", () => {
  it("returns null when unassigned", () => {
    expect(assigneeBadge(null)).toBeNull();
  });

  it("uses the agent name with the session id as the title", () => {
    const badge = assigneeBadge(session);
    expect(badge).toEqual({
      tone: "agent",
      label: "@impl-bot",
      title: "sid-1",
    });
  });

  it("prefers a session name when present", () => {
    expect(assigneeBadge({ ...session, name: "Builder" })?.label).toBe(
      "@Builder",
    );
  });
});

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

  it("shows a muted badge while the state is unknown", () => {
    const badge = mergeableBadge(pull({ mergeable_state: "unknown" }));
    expect(badge?.tone).toBe("unknown");
    expect(badge?.label).toBe("checking…");
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

describe("issueBadges / pullBadges", () => {
  it("orders agent before state on issues", () => {
    const badges = issueBadges(issue({ assignee: session, state: "closed" }));
    expect(badges.map((b) => b.tone)).toEqual(["agent", "closed"]);
  });

  it("collects agent, review and conflict badges on a PR", () => {
    const badges = pullBadges(
      pull({
        assignee: session,
        review_state: "APPROVED",
        mergeable_state: "dirty",
      }),
    );
    expect(badges.map((b) => b.tone)).toEqual([
      "agent",
      "review-approved",
      "conflict",
    ]);
  });

  it("shows the mergeable badge on a clean open PR", () => {
    const badges = pullBadges(pull({ mergeable_state: "clean" }));
    expect(badges.map((b) => b.tone)).toEqual(["mergeable"]);
  });
});
