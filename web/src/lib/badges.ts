// Pure helpers for the status badges shown on dashboard rows. Ported from the
// v1 UI (src/ui.html) for parity: state, review state, mergeable/conflict.
// Kept dependency-free so the badge logic is unit-testable without React.

import type { Issue, LinkedPull, PullRequest } from "@/api/types";

export type BadgeTone =
  | "open"
  | "closed"
  | "draft"
  | "merged"
  | "review-passed"
  | "review-changes"
  | "review-rereview"
  | "review-commented"
  | "mergeable"
  | "conflict"
  | "working"
  | "unknown"
  // Violet tone, used by the related-sessions "dev" and handoff "code" badges.
  | "agent";

export interface Badge {
  tone: BadgeTone;
  label: string;
  /** Tooltip text, when useful. */
  title?: string;
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
  PASSED: "review-passed",
  CHANGES_REQUESTED: "review-changes",
  READY_FOR_RE_REVIEW: "review-rereview",
  COMMENTED: "review-commented",
  // A previously-passed PR whose head advanced past the passed commit: the
  // pass is dismissed and the PR needs another look before merging.
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
    case "conflict":
      return { tone: "conflict", label: "conflict" };
    default:
      return null;
  }
}

/**
 * "draft" badge for an open, unmerged WIP PR (#413). `lh dev` opens the PR at the start of work,
 * so it stays draft until `lh pr ready-for-review` flips it; surfacing it keeps a still-in-progress
 * PR from reading as reviewable. Null for merged/closed PRs and once the PR is ready.
 */
export function draftBadge(pr: PullRequest): Badge | null {
  if (pr.merged || pr.state !== "open" || !pr.draft) return null;
  return {
    tone: "draft",
    label: "draft",
    title: "Work in progress — not yet ready for review",
  };
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

/** All badges for an issue row. */
export function issueBadges(issue: Issue): Badge[] {
  const badges: Badge[] = [];
  const state = stateBadge(issue, "issues");
  if (state) badges.push(state);
  return badges;
}

/** All badges for a pull-request row (working, state, review, conflict). */
export function pullBadges(pr: PullRequest): Badge[] {
  const badges: Badge[] = [];
  const draft = draftBadge(pr);
  if (draft) badges.push(draft);
  const working = workingBadge(pr);
  if (working) badges.push(working);
  const state = stateBadge(pr, "pulls");
  if (state) badges.push(state);
  const review = reviewBadge(pr);
  // While the PR is working (worktree dirty), hide the "passed" badge: the
  // state is still moving, so "passed" would wrongly imply it is ready to
  // merge. Other review states (changes requested, stale, …) still show.
  if (review && !(working && review.tone === "review-passed")) {
    badges.push(review);
  }
  const mergeable = mergeableBadge(pr);
  // Same reasoning: hide "mergeable" while working. "conflict" still shows —
  // a conflict is worth surfacing regardless of in-progress work.
  if (mergeable && !(working && mergeable.tone === "mergeable")) {
    badges.push(mergeable);
  }
  return badges;
}

/**
 * Badges for the canonical PR status line — state, review, and mergeable shown
 * unconditionally. Unlike {@link pullBadges}, this never suppresses "passed" /
 * "mergeable" while the worktree is dirty and never adds a "working" badge: it
 * is the exact trio the PR detail page (pull-detail.tsx) renders. The
 * dashboard PR rows keep {@link pullBadges} — the compact "working" cue is
 * wanted in the list.
 */
export function pullDetailBadges(pr: PullRequest): Badge[] {
  const badges: Badge[] = [];
  const draft = draftBadge(pr);
  if (draft) badges.push(draft);
  const state = stateBadge(pr, "pulls");
  if (state) badges.push(state);
  const review = reviewBadge(pr);
  if (review) badges.push(review);
  const mergeable = mergeableBadge(pr);
  if (mergeable) badges.push(mergeable);
  return badges;
}

/**
 * Single status descriptor for an issue row's linked PR (the issue-list
 * sub-row). Collapses the PR's review / conflict / working signals into one
 * toned, labelled word, by priority. A *decided* review state (passed /
 * changes / re-review / commented) or an actionable conflict reflects the PR's
 * real state and so outranks the transient "working" cue — otherwise a
 * passed PR whose dev worktree still has uncommitted changes would read
 * "working" on the issue list while the PR detail page reads "passed" (the
 * #419 inconsistency). "working" is only the *fallback* word for an open PR
 * with no decided status (fresh, blocked, unknown), shown instead of a bare
 * `PR #n` pill. Matches the PR detail page ({@link pullDetailBadges}), so the
 * same PR reads the same word everywhere issue status is rendered.
 * Priority (most actionable first):
 *   merged → closed → conflict → changes/re-review/commented/passed →
 *   working (open, status computed but undecided).
 *
 * Returns null only when the status fields are absent (`mergeable_state ===
 * undefined`, the issue-detail summary path that does not compute them), so the
 * row is not wrongly labelled "working".
 */
export function linkedPullStatus(pull: LinkedPull): Badge | null {
  if (pull.merged) return { tone: "merged", label: "merged" };
  if (pull.state === "closed") return { tone: "closed", label: "closed" };
  // A decided, actionable conflict wins even while the worktree is being edited.
  if (pull.mergeable_state === "conflict")
    return { tone: "conflict", label: "conflict" };
  // Decided review states reflect the PR's real state and win over the transient
  // "working" cue (#419): a passed PR with a dirty worktree reads "passed",
  // matching the PR detail page rather than masking it behind "working".
  switch (pull.review_state) {
    case "CHANGES_REQUESTED":
      return { tone: "review-changes", label: "changes" };
    case "READY_FOR_RE_REVIEW":
    case "STALE":
      return { tone: "review-rereview", label: "re-review" };
    case "COMMENTED":
      return { tone: "review-commented", label: "commented" };
    case "PASSED":
      return { tone: "review-passed", label: "passed" };
  }
  // No decided review state. Worktree dirty: actively being edited.
  if (pull.working)
    return {
      tone: "working",
      label: "working",
      title: "Uncommitted changes in the PR worktree",
    };
  // Status computed (issue-list path) but nothing decided yet = fresh/in-progress
  // → working. Not computed (issue-detail summary path) → indeterminable → null.
  if (pull.mergeable_state === undefined) return null;
  return {
    tone: "working",
    label: "working",
    title: "No review or conflict status yet",
  };
}

/**
 * State badge for a linked PR using only the always-present fields (state +
 * merged) — merged → "merged", closed → "closed", otherwise "open". Unlike
 * {@link linkedPullStatus} this never returns null, so the issue-detail summary
 * (which lacks the git-derived status fields) can always show the PR's state.
 */
export function linkedPullStateBadge(pull: LinkedPull): Badge {
  if (pull.merged) return { tone: "merged", label: "merged" };
  if (pull.state === "closed") return { tone: "closed", label: "closed" };
  return { tone: "open", label: "open" };
}

/**
 * PR pill tone for the linked-PR sub-row — the *lifecycle* axis (is this PR
 * worth looking at): open → green, merged → purple, closed → grey. Independent
 * of the status word's colour: a live (green) PR can still carry a red conflict
 * word. A null status (issue-detail summary path) shows a muted pill.
 */
export function linkedPullPillTone(pull: LinkedPull): BadgeTone {
  if (pull.merged) return "merged";
  if (pull.state === "closed") return "closed";
  return "open";
}

/**
 * Status-word colour for the linked-PR sub-row — the *state-specific* axis,
 * independent of {@link linkedPullPillTone}. A minimal palette that paints only
 * the signals worth attention: `danger` (conflict / changes — act now), `ready`
 * (passed), `done` (merged); everything else (working / re-review / commented
 * / closed) is `muted`, the default, so the few coloured words stand out. The
 * component maps these categories to text colours (dashboard-rows.tsx).
 */
export type StatusWordTone = "danger" | "ready" | "done" | "muted";

export function linkedPullWordTone(tone: BadgeTone): StatusWordTone {
  switch (tone) {
    case "conflict":
    case "review-changes":
      return "danger";
    case "review-passed":
      return "ready";
    case "merged":
      return "done";
    default:
      return "muted";
  }
}
