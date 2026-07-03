// Pure helpers for the status badges shown on dashboard rows. Ported from the
// v1 UI (src/ui.html) for parity: state, review state, mergeable/conflict.
// Kept dependency-free so the badge logic is unit-testable without React.

import type { Issue, LinkedPull, PullRequest } from "@/api/types";

/**
 * The issue's most relevant linked PR — `linked_pull_requests[0]` when the
 * array is present, falling back to the singular field for responses that
 * only carry it. Both are already ordered/selected the same way as
 * `linkedPullForIssue`/`linkedPullsForIssue` (core/store.ts): open & unmerged
 * first, then most recent. The single source every Build-button call site
 * should read instead of re-deriving "which PR counts" itself.
 */
export function primaryLinkedPull(issue: Issue): LinkedPull | null {
  return issue.linked_pull_requests?.[0] ?? issue.linked_pull_request ?? null;
}

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

interface PullStatusOptions {
  agentWorking?: boolean;
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
export function workingBadge(
  pr: PullRequest,
  options: PullStatusOptions = {},
): Badge | null {
  if (pr.merged || pr.state !== "open" || !(pr.working || options.agentWorking))
    return null;
  return {
    tone: "working",
    label: "working",
    title: options.agentWorking
      ? "Herdr agent is working in the PR worktree"
      : "Uncommitted changes in the PR worktree",
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
export function pullBadges(
  pr: PullRequest,
  options: PullStatusOptions = {},
): Badge[] {
  const badges: Badge[] = [];
  const draft = draftBadge(pr);
  if (draft) badges.push(draft);
  const working = workingBadge(pr, options);
  if (working) badges.push(working);
  const state = stateBadge(pr, "pulls");
  if (state) return [state];
  const review = reviewBadge(pr);
  // While a live herdr agent is working in the PR worktree, hold review-result
  // statuses behind the working badge. A dirty worktree without a live working
  // agent keeps the older, narrower suppression of only "passed".
  if (
    review &&
    !(options.agentWorking || (working && review.tone === "review-passed"))
  ) {
    badges.push(review);
  }
  const mergeable = mergeableBadge(pr);
  // Same reasoning: hide "mergeable" while working. "conflict" still shows:
  // conflict handling is intentionally unchanged.
  if (mergeable && !(working && mergeable.tone === "mergeable")) {
    badges.push(mergeable);
  }
  return badges;
}

/**
 * Badges for the canonical PR status line — state, review, and mergeable shown
 * unconditionally for ordinary PR data. A live herdr working agent is the one
 * exception: it adds a "working" badge and suppresses review-result / mergeable
 * badges while the PR is actively changing. Dirty-worktree `pr.working` alone
 * stays list-only so the detail header does not change for stale uncommitted
 * state.
 */
export function pullDetailBadges(
  pr: PullRequest,
  options: PullStatusOptions = {},
): Badge[] {
  const badges: Badge[] = [];
  const draft = draftBadge(pr);
  if (draft) badges.push(draft);
  const working = options.agentWorking
    ? workingBadge(pr, { agentWorking: true })
    : null;
  if (working) badges.push(working);
  const state = stateBadge(pr, "pulls");
  if (state) return [state];
  const review = reviewBadge(pr);
  if (review && !options.agentWorking) badges.push(review);
  const mergeable = mergeableBadge(pr);
  if (mergeable && !(options.agentWorking && mergeable.tone === "mergeable"))
    badges.push(mergeable);
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
export function linkedPullStatus(
  pull: LinkedPull,
  options: PullStatusOptions = {},
): Badge | null {
  if (pull.merged) return { tone: "merged", label: "merged" };
  if (pull.state === "closed") return { tone: "closed", label: "closed" };
  // A decided, actionable conflict wins even while the worktree is being edited.
  if (pull.mergeable_state === "conflict")
    return { tone: "conflict", label: "conflict" };
  if (options.agentWorking) {
    return {
      tone: "working",
      label: "working",
      title: "Herdr agent is working in the PR worktree",
    };
  }
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

/**
 * Build-button state for an issue (#598), shared by every render site (issue
 * detail header, its grouped-issues rows, the issues list, the repo
 * dashboard, and the home "Recent issues" rows — all render through
 * {@link primaryLinkedPull} + this one switch):
 *   - "build": no linked PR, or the primary one closed without merging
 *     (rejected attempt) — the clickable Build button shows.
 *   - "building": the primary linked PR is open and unmerged — Build is
 *     replaced by a disabled "Building" label.
 *   - "merged": the primary linked PR merged — Build is replaced by a
 *     disabled "Merged" label.
 */
export type BuildButtonState = "build" | "building" | "merged";

export function issueBuildButtonState(issue: Issue): BuildButtonState {
  const pull = primaryLinkedPull(issue);
  if (!pull) return "build";
  if (pull.merged) return "merged";
  if (pull.state === "open") return "building";
  return "build";
}
