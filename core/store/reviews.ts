import { db, now } from "../db.ts";
import { touchIssue } from "./issues.ts";
import { getPull } from "./pulls.ts";

// ---- reviews ----
export function listReviews(issueId: number): any[] {
  return (
    db
      // id ASC is a deterministic tiebreaker: now() has 1-second resolution, so
      // two reviews on the same topic in the same second would otherwise have an
      // undefined order — and computeReviewGate / latestSubstantiveReview rely on
      // last-write-per-topic to gate merges (#427).
      .query(
        `SELECT * FROM reviews WHERE issue_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(issueId)
  );
}
export function createReview(
  issueId: number,
  author: string,
  event: string,
  body: string,
  headSha: string | null = null,
  topic: string | null = null,
): any {
  return db
    .query(
      `INSERT INTO reviews (issue_id, author, event, body, head_sha, topic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(issueId, author, event, body, headSha, topic, now());
}

export type ReviewState =
  | "PASSED"
  | "CHANGES_REQUESTED"
  | "READY_FOR_RE_REVIEW"
  | "COMMENTED"
  | "STALE"
  | null;

export function latestSubstantiveReview(issueId: number): any | null {
  const reviews = listReviews(issueId);
  for (let i = reviews.length - 1; i >= 0; i--) {
    const event = reviews[i].event;
    if (event === "PASS" || event === "REQUEST_CHANGES") return reviews[i];
  }
  return null;
}

export function computeReviewState(issueId: number): ReviewState {
  const p = getPull(issueId);
  const latest = latestSubstantiveReview(issueId);
  if (!latest) {
    return listReviews(issueId).some((r) => r.event === "COMMENT")
      ? "COMMENTED"
      : null;
  }
  if (latest.event === "PASS") {
    // A PASS is stale once the branch head advances past the commit it was made
    // against. Passes recorded before head_sha tracking (no recorded sha) stay
    // PASSED, since their staleness can't be determined.
    if (latest.head_sha && p.head_sha && latest.head_sha !== p.head_sha)
      return "STALE";
    return "PASSED";
  }
  if (latest.event === "REQUEST_CHANGES") {
    return p.changes_addressed_at ? "READY_FOR_RE_REVIEW" : "CHANGES_REQUESTED";
  }
  return null;
}

// Per-topic merge gate (#427). The merge gate is no longer a single PASS:
// every review topic must pass independently. A topic "passes" when its latest
// substantive review (PASS / REQUEST_CHANGES) is a fresh PASS — i.e. not a
// REQUEST_CHANGES (no unresolved change request) and not a pass made stale by
// the head advancing past the reviewed commit (mirrors computeReviewState's STALE
// rule, so a passed-then-changed PR is not silently mergeable again). Topics are
// aggregated separately so a REQUEST_CHANGES on any one aspect blocks merge even
// when other aspects passed. The untagged (NULL) topic is one bucket of its own.
export interface ReviewGate {
  /** At least one topic has a substantive review (PASS / REQUEST_CHANGES). */
  reviewed: boolean;
  /** Every reviewed topic's latest substantive review passes (fresh PASS). */
  allTopicsPassed: boolean;
}

export function computeReviewGate(issueId: number): ReviewGate {
  const p = getPull(issueId);
  // ASC order (listReviews) → the last write per topic wins = latest substantive
  // review for that topic.
  const latestByTopic = new Map<string | null, any>();
  for (const r of listReviews(issueId)) {
    if (r.event === "PASS" || r.event === "REQUEST_CHANGES")
      latestByTopic.set(r.topic ?? null, r);
  }
  // No substantive review yet → reviews not gathered; never clean.
  if (latestByTopic.size === 0)
    return { reviewed: false, allTopicsPassed: false };
  for (const r of latestByTopic.values()) {
    if (r.event === "REQUEST_CHANGES")
      return { reviewed: true, allTopicsPassed: false };
    // PASS that went stale (head moved past the reviewed commit) needs a
    // re-review; passes with no recorded head_sha (pre-tracking) can't be
    // determined stale, so they count as passing.
    if (r.head_sha && p.head_sha && r.head_sha !== p.head_sha)
      return { reviewed: true, allTopicsPassed: false };
  }
  return { reviewed: true, allTopicsPassed: true };
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
): any {
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
    );
}

export function listReviewComments(issueId: number): any[] {
  return db
    .query(
      `SELECT * FROM review_comments WHERE issue_id = ? ORDER BY created_at ASC`,
    )
    .all(issueId);
}
