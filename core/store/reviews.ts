import { db, now } from "../db.ts";
import { touchIssue } from "./issues.ts";
import { getPull } from "./pulls.ts";

export interface ReviewRow {
  id: number;
  issue_id: number;
  author: string;
  event: string;
  body: string;
  head_sha: string | null;
  topic: string | null;
  model: string | null;
  created_at: string;
}

export interface ReviewCommentRow {
  id: number;
  issue_id: number;
  review_id: number | null;
  author: string;
  body: string;
  path: string;
  line: number | null;
  side: string | null;
  created_at: string;
}

// ---- reviews ----
export function listReviews(issueId: number): ReviewRow[] {
  return (
    db
      // id ASC is a deterministic tiebreaker: now() has 1-second resolution, so
      // two reviews on the same topic in the same second would otherwise have an
      // undefined order — and computeReviewStatus relies on last-write-per-topic
      // to gate merges (#427).
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
  topic: string | null = null,
  model: string | null = null,
): ReviewRow {
  return db
    .query(
      `INSERT INTO reviews (issue_id, author, event, body, head_sha, topic, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      issueId,
      author,
      event,
      body,
      headSha,
      topic,
      model,
      now(),
    ) as ReviewRow;
}

export type ReviewState =
  | "PASSED"
  | "CHANGES_REQUESTED"
  | "READY_FOR_RE_REVIEW"
  | "COMMENTED"
  | "STALE"
  | null;

// Per-topic merge gate (#427). The merge gate is no longer a single PASS:
// every review topic must pass independently. A topic "passes" when its latest
// substantive review (PASS / REQUEST_CHANGES) is a fresh PASS — i.e. not a
// REQUEST_CHANGES (no unresolved change request) and not a pass made stale by
// the head advancing past the reviewed commit (the same STALE rule computeReviewStatus
// applies, so a passed-then-changed PR is not silently mergeable again). Topics are
// aggregated separately so a REQUEST_CHANGES on any one aspect blocks merge even
// when other aspects passed. The untagged (NULL) topic is one bucket of its own.
export interface ReviewGate {
  /** At least one topic has a substantive review (PASS / REQUEST_CHANGES). */
  reviewed: boolean;
  /** Every reviewed topic's latest substantive review passes (fresh PASS). */
  allTopicsPassed: boolean;
  /** Latest substantive review status for every topic, in first-seen order. */
  topics: ReviewTopicGate[];
}

export type ReviewTopicState = "passed" | "stale" | "changes_requested";
export type ReviewBlockingReason = "stale" | "request_changes";

export interface ReviewTopicGate {
  topic: string | null;
  headSha: string | null;
  state: ReviewTopicState;
  blockingReason: ReviewBlockingReason | null;
}

export interface ReviewStatus {
  state: ReviewState;
  gate: ReviewGate;
}

function reviewGate(
  reviews: ReviewRow[],
  currentHeadSha: string | null,
): ReviewGate {
  // ASC order (listReviews) → the last write per topic wins = latest substantive
  // review for that topic. FEEDBACK (non-blocking human/crit feedback, #1674) is
  // deliberately excluded here so it never forms a topic bucket: a FEEDBACK-only PR
  // stays gate-neutral (unreviewed, not blocked, not mergeable-by-itself).
  const latestByTopic = new Map<string | null, ReviewRow>();
  for (const r of reviews) {
    if (r.event === "PASS" || r.event === "REQUEST_CHANGES")
      latestByTopic.set(r.topic ?? null, r);
  }
  const topics = Array.from(latestByTopic.entries()).map(([topic, r]) => {
    if (r.event === "REQUEST_CHANGES") {
      return {
        topic,
        headSha: r.head_sha,
        state: "changes_requested",
        blockingReason: "request_changes",
      } satisfies ReviewTopicGate;
    }
    // A PASS that went stale needs a re-review. Passes with no recorded
    // head_sha (pre-tracking) cannot be determined stale, so they still pass.
    if (r.head_sha && currentHeadSha && r.head_sha !== currentHeadSha) {
      return {
        topic,
        headSha: r.head_sha,
        state: "stale",
        blockingReason: "stale",
      } satisfies ReviewTopicGate;
    }
    return {
      topic,
      headSha: r.head_sha,
      state: "passed",
      blockingReason: null,
    } satisfies ReviewTopicGate;
  });
  return {
    reviewed: topics.length > 0,
    allTopicsPassed:
      topics.length > 0 && topics.every((topic) => topic.state === "passed"),
    topics,
  };
}

/**
 * Compute the display state and per-topic merge gate from the same review
 * snapshot. This keeps the user-facing state consistent with merge blocking:
 * any unresolved change request wins, then any stale topic, and only a fresh
 * PASS for every reviewed topic produces PASSED.
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
  if (gate.topics.some((topic) => topic.state === "changes_requested")) {
    return {
      state: p.changes_addressed_at
        ? "READY_FOR_RE_REVIEW"
        : "CHANGES_REQUESTED",
      gate,
    };
  }
  if (gate.topics.some((topic) => topic.state === "stale")) {
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

export function markChangesAddressed(issueId: number, actor: string) {
  db.run(
    `UPDATE pulls SET changes_addressed_at = ?, changes_addressed_by = ? WHERE issue_id = ?`,
    [now(), actor, issueId],
  );
  touchIssue(issueId);
}

export function clearChangesAddressed(issueId: number) {
  db.run(
    `UPDATE pulls SET changes_addressed_at = NULL, changes_addressed_by = NULL WHERE issue_id = ?`,
    [issueId],
  );
}

// ---- review comments (行コメント。投稿は review に束ねる) ----
export function createReviewComment(
  issueId: number,
  reviewId: number,
  author: string,
  c: { path: string; line?: number; side?: string; body: string },
): ReviewCommentRow {
  return db
    .query(
      `INSERT INTO review_comments (issue_id, review_id, author, body, path, line, side, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      issueId,
      reviewId,
      author,
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
