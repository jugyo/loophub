// Pure helpers for the status badges shown on dashboard rows. Ported from the
// v1 UI (src/ui.html) for parity: state, review state, mergeable/conflict,
// and assignee (agent). Kept dependency-free so the badge logic is
// unit-testable without React.

import type { AgentSession, Issue, PullRequest } from "@/api/types";

export type BadgeTone =
  | "open"
  | "closed"
  | "merged"
  | "review-approved"
  | "review-changes"
  | "review-rereview"
  | "review-commented"
  | "mergeable"
  | "conflict"
  | "working"
  | "unknown"
  | "agent";

export interface Badge {
  tone: BadgeTone;
  label: string;
  /** Tooltip text (e.g. agent session id), when useful. */
  title?: string;
}

/** Display name for an assignee/agent session, mirroring v1 assigneeLabel. */
export function assigneeLabel(a: AgentSession | null | undefined): string {
  if (!a) return "";
  return a.name || a.agent || "agent";
}

/** "@name" agent badge for an assigned session, or null when unassigned. */
export function assigneeBadge(
  a: AgentSession | null | undefined,
): Badge | null {
  if (!a) return null;
  return {
    tone: "agent",
    label: `@${assigneeLabel(a)}`,
    title: a.session_id || undefined,
  };
}

/** State badge: open/closed for issues, merged for merged PRs. Open PRs show none. */
export function stateBadge(
  item: Issue | PullRequest,
  kind: "issues" | "pulls",
): Badge | null {
  if (kind === "pulls") {
    const pr = item as PullRequest;
    if (pr.merged) return { tone: "merged", label: "merged" };
    if (pr.state === "open") return null;
    return { tone: "closed", label: "closed" };
  }
  if (item.state === "open") return { tone: "open", label: "open" };
  return { tone: "closed", label: "closed" };
}

const REVIEW_TONE: Record<
  NonNullable<PullRequest["review_state"]>,
  BadgeTone
> = {
  APPROVED: "review-approved",
  CHANGES_REQUESTED: "review-changes",
  READY_FOR_RE_REVIEW: "review-rereview",
  COMMENTED: "review-commented",
  // A previously-approved PR whose head advanced past the approved commit: the
  // approval is dismissed and the PR needs another look before merging.
  STALE: "review-rereview",
};

/** Review-state badge for a PR, or null when there is no review yet. */
export function reviewBadge(pr: PullRequest): Badge | null {
  if (!pr.review_state) return null;
  return {
    tone: REVIEW_TONE[pr.review_state],
    label: pr.review_state.replace(/_/g, " ").toLowerCase(),
  };
}

/**
 * Mergeable-state badge for an open, unmerged PR: a green "mergeable" when the
 * tree merges cleanly, a red "conflict" on a dirty tree. Returns null for every
 * other state — merged or non-open PRs, and the muted states ("no commits",
 * "blocked"/needs approval, and the not-yet-computed "unknown"), which carry
 * little signal and only add noise.
 */
export function mergeableBadge(pr: PullRequest): Badge | null {
  if (pr.merged || pr.state !== "open") return null;
  switch (pr.mergeable_state) {
    case "clean":
      return { tone: "mergeable", label: "mergeable" };
    case "dirty":
      return { tone: "conflict", label: "conflict" };
    default:
      return null;
  }
}

/**
 * "working" badge for an open PR whose lh-dev worktree has uncommitted changes — a quick
 * "actively being worked on" cue. Null for merged/closed PRs or when the flag is absent/false
 * (no worktree, clean tree, or an older server that doesn't send it).
 */
export function workingBadge(pr: PullRequest): Badge | null {
  if (pr.merged || pr.state !== "open" || !pr.working) return null;
  return {
    tone: "working",
    label: "working",
    title: "Uncommitted changes in the PR worktree",
  };
}

/** All badges for an issue row (v1 parity ordering: agent, state). */
export function issueBadges(issue: Issue): Badge[] {
  const badges: Badge[] = [];
  const agent = assigneeBadge(issue.assignee);
  if (agent) badges.push(agent);
  const state = stateBadge(issue, "issues");
  if (state) badges.push(state);
  return badges;
}

/** All badges for a pull-request row (agent, working, state, review, conflict). */
export function pullBadges(pr: PullRequest): Badge[] {
  const badges: Badge[] = [];
  const agent = assigneeBadge(pr.assignee ?? null);
  if (agent) badges.push(agent);
  const working = workingBadge(pr);
  if (working) badges.push(working);
  const state = stateBadge(pr, "pulls");
  if (state) badges.push(state);
  const review = reviewBadge(pr);
  if (review) badges.push(review);
  const conflict = mergeableBadge(pr);
  if (conflict) badges.push(conflict);
  return badges;
}
