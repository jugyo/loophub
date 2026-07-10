import {
  actorFor,
  ensureWritable,
  issueOr404,
  repoOr404,
  reviewCommentJSON,
  reviewJSON,
  S,
  ServiceError,
} from "./shared.ts";

// ===== reviews =====
export const reviews = {
  list(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return S.listReviews(row.id).map(reviewJSON);
  },

  listComments(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return S.listReviewComments(row.id).map(reviewCommentJSON);
  },

  create(
    name: string,
    number: number,
    input: {
      event?: string;
      body?: string;
      topic?: string;
      model?: string;
      headSha?: string;
      comments?: { path: string; line?: number; side?: string; body: string }[];
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    let event = (input.event ?? "COMMENT").toUpperCase();
    // Back-compat: pre-#428 callers still pass "approve" (the old vocabulary).
    if (event === "APPROVE") event = "PASS";
    // Aspect/topic of the review (e.g. design/bug/style/security), so a single
    // commit can carry several reviews distinguished by topic (#209). Free-form;
    // a blank topic is stored as NULL (untagged).
    const topic = input.topic?.trim() || null;
    // The agent/model that produced the review (#1107). Free-form; a blank model
    // is stored as NULL (unattributed), preserving pre-#1107 behavior.
    const model = input.model?.trim() || null;
    const lineComments = Array.isArray(input.comments) ? input.comments : [];
    for (const cm of lineComments) {
      if (!cm?.path || !cm?.body)
        throw new ServiceError(422, "each comment requires path and body");
    }
    const actor = actorFor(sessionId);
    // Bind the review to the head it was made against so a PASS can be
    // marked stale once the branch advances past this commit.
    const headSha = input.headSha ?? S.getPull(row.id)?.head_sha ?? null;
    const v = S.createReview(
      row.id,
      actor,
      event,
      input.body ?? "",
      headSha,
      topic,
      model,
    );
    for (const cm of lineComments) {
      S.createReviewComment(row.id, v.id, actor, {
        path: cm.path,
        line: cm.line,
        side: cm.side,
        body: cm.body,
      });
    }
    if (event === "PASS" || event === "REQUEST_CHANGES")
      S.clearChangesAddressed(row.id);
    S.emitEvent(r.id, "pull_request.review_submitted", actor, {
      number: row.number,
      state: event,
      topic,
      comments: lineComments.length,
    });
    return { ...reviewJSON(v), comments: lineComments.length };
  },
};
