import { db, now } from "../db.ts";
import type { CommentAuthorType } from "./comments.ts";
import { getPull } from "./pulls.ts";

export interface ReviewRow {
  id: number;
  issue_id: number;
  author: string;
  author_type: CommentAuthorType;
  event: string;
  body: string;
  head_sha: string | null;
  model: string | null;
  created_at: string;
}

export interface ReviewCommentRow {
  id: number;
  issue_id: number;
  review_id: number | null;
  author: string;
  author_type: CommentAuthorType;
  body: string;
  path: string;
  line: number | null;
  side: string | null;
  created_at: string;
}

export interface ReviewResponseRow {
  id: number;
  issue_id: number;
  review_id: number;
  review_comment_id: number | null;
  author: string;
  body: string;
  created_at: string;
}

export interface ReviewAcResultRow {
  id: number;
  review_id: number;
  criterion_id: number;
  verdict: string; // 'pass' | 'fail'
  note: string;
  created_at: string;
}

// ---- reviews ----
export function listReviews(issueId: number): ReviewRow[] {
  return (
    db
      // id ASC is a deterministic tiebreaker: now() has 1-second resolution, so
      // two reviews in the same second would otherwise have an undefined order —
      // and computeReviewStatus relies on the last substantive write to gate
      // merges (#1934).
      .query(
        `SELECT * FROM reviews WHERE issue_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(issueId) as ReviewRow[]
  );
}
export function createReview(
  issueId: number,
  author: string,
  event: string,
  body: string,
  headSha: string | null = null,
  model: string | null = null,
  authorType: CommentAuthorType = "system",
): ReviewRow {
  return db
    .query(
      `INSERT INTO reviews
       (issue_id, author, author_type, event, body, head_sha, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      issueId,
      author,
      authorType,
      event,
      body,
      headSha,
      model,
      now(),
    ) as ReviewRow;
}

// Create a review row and its per-criterion grades atomically (#1895). The grades are children of
// the review row (staleness follows the review), so they must not survive without it — a single
// transaction guarantees a review either carries all its grades or none. The caller validates
// criterion ownership before this runs; here we only persist. `acResults` is empty for a holistic
// review (no structured grading), which degenerates to a plain review insert.
export function createReviewWithAcResults(
  issueId: number,
  author: string,
  event: string,
  body: string,
  headSha: string | null,
  model: string | null,
  acResults: { criterionId: number; verdict: string; note: string }[],
  authorType: CommentAuthorType = "system",
): ReviewRow {
  return db.transaction(() => {
    const review = createReview(
      issueId,
      author,
      event,
      body,
      headSha,
      model,
      authorType,
    );
    for (const r of acResults)
      createReviewAcResult(review.id, r.criterionId, r.verdict, r.note);
    return review;
  });
}

export type ReviewState =
  | "PASSED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "STALE"
  | null;

// The merge gate is flat (#1934): the PR's single latest substantive review
// (PASS / REQUEST_CHANGES) decides it. It passes when that review is a fresh
// PASS — i.e. not a REQUEST_CHANGES (no unresolved change request) and not a
// pass made stale by the head advancing past the reviewed commit (the same STALE
// rule computeReviewStatus applies, so a passed-then-changed PR is not silently
// mergeable again). The retired per-topic gate (#427) bucketed reviews by
// `reviews.topic`, which let a bucket nobody could reach block merge forever.
export interface ReviewGate {
  /** The PR has a substantive review (PASS / REQUEST_CHANGES). */
  reviewed: boolean;
  /** The latest substantive review is a fresh PASS — the gate is open. */
  passed: boolean;
  /** Head SHA the latest substantive review was pinned to; null when unreviewed or untracked. */
  headSha: string | null;
  /** Why a reviewed PR is still blocked; null when the gate is open or unreviewed. */
  blockingReason: ReviewBlockingReason | null;
}

export type ReviewBlockingReason = "stale" | "request_changes";

export interface ReviewStatus {
  state: ReviewState;
  gate: ReviewGate;
}

function reviewGate(
  reviews: ReviewRow[],
  currentHeadSha: string | null,
): ReviewGate {
  // ASC order (listReviews) → the last substantive write wins. FEEDBACK
  // (non-blocking human feedback, #1674) is deliberately excluded here so it
  // never moves the gate: a FEEDBACK-only PR stays gate-neutral (unreviewed, not
  // blocked, not mergeable-by-itself).
  let latest: ReviewRow | null = null;
  for (const r of reviews) {
    if (r.event === "PASS" || r.event === "REQUEST_CHANGES") latest = r;
  }
  if (!latest)
    return {
      reviewed: false,
      passed: false,
      headSha: null,
      blockingReason: null,
    };
  if (latest.event === "REQUEST_CHANGES")
    return {
      reviewed: true,
      passed: false,
      headSha: latest.head_sha,
      blockingReason: "request_changes",
    };
  // A PASS that went stale needs a re-review. Passes with no recorded
  // head_sha (pre-tracking) cannot be determined stale, so they still pass.
  if (latest.head_sha && currentHeadSha && latest.head_sha !== currentHeadSha)
    return {
      reviewed: true,
      passed: false,
      headSha: latest.head_sha,
      blockingReason: "stale",
    };
  return {
    reviewed: true,
    passed: true,
    headSha: latest.head_sha,
    blockingReason: null,
  };
}

/**
 * Compute the display state and merge gate from the same review snapshot. This
 * keeps the user-facing state consistent with merge blocking: an unresolved
 * change request wins, then a stale pass, and only a fresh PASS produces PASSED.
 */
export function computeReviewStatus(
  issueId: number,
  currentHeadSha?: string | null,
): ReviewStatus {
  const p = getPull(issueId)!;
  const reviews = listReviews(issueId);
  const gate = reviewGate(
    reviews,
    currentHeadSha === undefined ? p.head_sha : currentHeadSha,
  );
  if (!gate.reviewed) {
    return {
      state: reviews.some((r) => r.event === "COMMENT") ? "COMMENTED" : null,
      gate,
    };
  }
  if (gate.blockingReason === "request_changes") {
    return { state: "CHANGES_REQUESTED", gate };
  }
  if (gate.blockingReason === "stale") {
    return { state: "STALE", gate };
  }
  return { state: "PASSED", gate };
}

export function computeReviewGate(
  issueId: number,
  currentHeadSha?: string | null,
): ReviewGate {
  return computeReviewStatus(issueId, currentHeadSha).gate;
}

// ---- review comments (行コメント。投稿は review に束ねる) ----
export function createReviewComment(
  issueId: number,
  reviewId: number,
  author: string,
  authorType: CommentAuthorType,
  c: { path: string; line?: number; side?: string; body: string },
): ReviewCommentRow {
  return db
    .query(
      `INSERT INTO review_comments
       (issue_id, review_id, author, author_type, body, path, line, side, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      issueId,
      reviewId,
      author,
      authorType,
      c.body,
      c.path,
      c.line ?? null,
      c.side ?? "RIGHT",
      now(),
    ) as ReviewCommentRow;
}

export function listReviewComments(issueId: number): ReviewCommentRow[] {
  return db
    .query(
      `SELECT * FROM review_comments WHERE issue_id = ? ORDER BY created_at ASC`,
    )
    .all(issueId) as ReviewCommentRow[];
}

export function createReviewResponse(
  issueId: number,
  reviewId: number,
  reviewCommentId: number | null,
  author: string,
  body: string,
): ReviewResponseRow {
  return db
    .query(
      `INSERT INTO review_responses
         (issue_id, review_id, review_comment_id, author, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      issueId,
      reviewId,
      reviewCommentId,
      author,
      body,
      now(),
    ) as ReviewResponseRow;
}

export function listReviewResponses(
  issueId: number,
  reviewId?: number,
): ReviewResponseRow[] {
  return (
    reviewId === undefined
      ? db
          .query(
            `SELECT * FROM review_responses
           WHERE issue_id = ? ORDER BY created_at ASC, id ASC`,
          )
          .all(issueId)
      : db
          .query(
            `SELECT * FROM review_responses
           WHERE issue_id = ? AND review_id = ? ORDER BY created_at ASC, id ASC`,
          )
          .all(issueId, reviewId)
  ) as ReviewResponseRow[];
}

// ---- review AC results (per-criterion grade。review に束ねる子ファクト) ----
export function createReviewAcResult(
  reviewId: number,
  criterionId: number,
  verdict: string,
  note: string,
): ReviewAcResultRow {
  return db
    .query(
      `INSERT INTO review_ac_results (review_id, criterion_id, verdict, note, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(reviewId, criterionId, verdict, note, now()) as ReviewAcResultRow;
}

export function listReviewAcResults(reviewId: number): ReviewAcResultRow[] {
  return db
    .query(
      `SELECT * FROM review_ac_results WHERE review_id = ? ORDER BY id ASC`,
    )
    .all(reviewId) as ReviewAcResultRow[];
}
