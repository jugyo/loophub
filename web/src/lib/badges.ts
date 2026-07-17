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
  | "cost-stopped"
  | "unknown"
  // Violet tone, used by the related-sessions "dev" and handoff "code" badges.
  | "agent";

export interface Badge {
  tone: BadgeTone;
  label: string;
  /** Tooltip text, when useful. */
  title?: string;
}

type PullStatusSource = {
  merged: boolean;
  state: "open" | "closed";
  working?: boolean;
  review_state?: PullRequest["review_state"];
  mergeable_state?: PullRequest["mergeable_state"];
};

interface PullStatusDecision {
  terminal: Badge | null;
  review: Badge | null;
  mergeable: Badge | null;
}

function resolveReviewState(
  reviewState?: PullRequest["review_state"],
): Badge | null {
  if (!reviewState) return null;
  return {
    tone: REVIEW_TONE[reviewState],
    label: REVIEW_LABEL[reviewState],
  };
}

function resolveMergeableState(
  merged: boolean,
  state: "open" | "closed",
  mergeableState?: PullRequest["mergeable_state"],
): Badge | null {
  if (merged || state !== "open") return null;
  switch (mergeableState) {
    case "clean":
      return { tone: "mergeable", label: "mergeable" };
    case "conflict":
      return { tone: "conflict", label: "conflict" };
    default:
      return null;
  }
}

function resolvePullStatus(pull: PullStatusSource): PullStatusDecision {
  return {
    terminal: pull.merged
      ? { tone: "merged", label: "merged" }
      : pull.state === "closed"
        ? { tone: "closed", label: "closed" }
        : null,
    review: resolveReviewState(pull.review_state),
    mergeable: resolveMergeableState(
      pull.merged,
      pull.state,
      pull.mergeable_state,
    ),
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
  PASSED: "review-passed",
  CHANGES_REQUESTED: "review-changes",
  READY_FOR_RE_REVIEW: "review-rereview",
  COMMENTED: "review-commented",
  // A previously-passed PR whose head advanced past the passed commit: the
  // pass is dismissed and the PR needs another look before merging.
  STALE: "review-rereview",
};

const REVIEW_LABEL: Record<NonNullable<PullRequest["review_state"]>, string> = {
  PASSED: "passed",
  CHANGES_REQUESTED: "changes",
  READY_FOR_RE_REVIEW: "re-review",
  COMMENTED: "commented",
  STALE: "re-review",
};

/** Review-state badge for a PR, or null when there is no review yet. */
export function reviewBadge(pr: PullRequest): Badge | null {
  return resolveReviewState(pr.review_state);
}

/**
 * Mergeable-state badge for an open, unmerged PR: a green "mergeable" when the
 * tree merges cleanly, a red "conflict" on a dirty tree. Returns null for every
 * other state — merged or non-open PRs, and the muted states ("no commits",
 * "blocked"/needs approval, and the not-yet-computed "unknown"), which carry
 * little signal and only add noise.
 */
export function mergeableBadge(pr: PullRequest): Badge | null {
  return resolveMergeableState(pr.merged, pr.state, pr.mergeable_state);
}

/**
 * "draft" badge for an open, unmerged WIP PR (#413). `lh build` opens the PR at the start of work,
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
 * "over budget" badge for a PR whose dev agent was force-stopped for exceeding its cost limit
 * (#863, driven by the `dev.cost_stopped` event surfaced as `cost_stopped`). The conceptual
 * escalation of the amber/red AgentCostBadge cost highlight: a stopped PR is stalled and needs a
 * human, so it is flagged wherever the PR appears. Null when the flag is absent/false (never
 * stopped, or an older server that doesn't send it).
 */
export function costStoppedBadge(pull: {
  cost_stopped?: boolean;
  merged?: boolean;
  state?: "open" | "closed";
}): Badge | null {
  // Like draft/working, a transient "needs attention" cue for an open PR: once the PR is
  // merged/closed the stall is resolved, so the badge is suppressed rather than left as stale noise
  // next to a "merged"/"closed" badge.
  if (!pull.cost_stopped || pull.merged || pull.state === "closed") return null;
  return {
    tone: "cost-stopped",
    label: "over budget",
    title: "Stopped — agent cost limit exceeded",
  };
}

/** All badges for an issue row. */
export function issueBadges(issue: Issue): Badge[] {
  const badges: Badge[] = [];
  const state = stateBadge(issue, "issues");
  if (state) badges.push(state);
  return badges;
}

/** All badges for a pull-request row (state, review, conflict). */
export function pullBadges(pr: PullRequest): Badge[] {
  const badges: Badge[] = [];
  const status = resolvePullStatus(pr);
  // #863: a stopped-for-cost PR is stalled and needs a human — flag it first, ahead of the
  // routine draft/working/review badges. Suppressed on merged/closed PRs (costStoppedBadge).
  const costStopped = costStoppedBadge(pr);
  if (costStopped) badges.push(costStopped);
  const draft = draftBadge(pr);
  if (draft) badges.push(draft);
  const state = status.terminal;
  if (state) return [state];
  const review = status.review;
  if (review) badges.push(review);
  const mergeable = status.mergeable;
  if (mergeable) badges.push(mergeable);
  return badges;
}

/**
 * Badges for the canonical PR status line — state, review, and mergeable shown
 * unconditionally for ordinary PR data. Agent activity is deliberately absent
 * from this status line; only states that may require attention are shown.
 */
export function pullDetailBadges(pr: PullRequest): Badge[] {
  const badges: Badge[] = [];
  const status = resolvePullStatus(pr);
  // #863: flag a stopped-for-cost PR first, ahead of the routine badges (see pullBadges).
  const costStopped = costStoppedBadge(pr);
  if (costStopped) badges.push(costStopped);
  const draft = draftBadge(pr);
  if (draft) badges.push(draft);
  const state = status.terminal;
  if (state) return [state];
  const review = status.review;
  if (review) badges.push(review);
  const mergeable = status.mergeable;
  if (mergeable) badges.push(mergeable);
  return badges;
}

/**
 * Single status descriptor for an issue row's linked PR (the issue-list
 * sub-row). Collapses the PR's review / conflict signals into one toned,
 * labelled word. Agent activity is deliberately omitted so routine work does
 * not mask the PR's review state.
 * Priority (most actionable first):
 *   merged → closed → conflict → changes/re-review/commented/passed.
 *
 * Returns null when nothing above applies — an idle open PR, or the issue-detail
 * summary path that lacks status fields — so {@link LinkedPullSummaryRow} falls
 * back to the plain lifecycle pill ("open") and dims the idle bot icon instead
 * of labelling the row "working".
 */
export function linkedPullStatus(pull: LinkedPull): Badge | null {
  const status = resolvePullStatus(pull);
  if (status.terminal) return status.terminal;
  // A decided, actionable conflict wins even while a live agent is editing.
  if (status.mergeable?.tone === "conflict") return status.mergeable;
  // Decided review states reflect the PR's real state (#419): a passed PR with a
  // dirty worktree reads "passed", matching the PR detail page.
  if (status.review) {
    return status.review;
  }
  // No live agent, no decided review/conflict: the PR is idle. Return null so
  // the row shows its plain lifecycle state and the dimmed idle styling.
  return null;
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
 * Whether an issue is ready to have work started on it (#598), i.e. it has no
 * active linked PR: either no linked PR at all, or the primary one closed
 * without merging (a rejected attempt). Returns false while the primary linked
 * PR is open (work in progress) or merged. Gates the issue detail's "Start
 * workflow" control so only one launch is offered per issue at a time.
 */
export function issueCanStartWork(issue: Issue): boolean {
  const pull = primaryLinkedPull(issue);
  if (!pull) return true;
  if (pull.merged) return false;
  if (pull.state === "open") return false;
  return true;
}
