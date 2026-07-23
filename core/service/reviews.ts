import {
  actorFor,
  ensureWritable,
  issueOr404,
  repoOr404,
  reviewCommentJSON,
  reviewJSON,
  revParse,
  S,
  ServiceError,
} from "./shared.ts";

// The running workflow run for this PR, if any. Unlike `latestWorkflowRunReview` (which stays
// scoped to this run's verifier children for transition decisions), the run-scoped observation
// event fires for any review the parent must route — the substantive PASS / REQUEST_CHANGES and
// the non-blocking-but-must-handle FEEDBACK (human/crit out-of-band, #1674) — so the parent always
// re-observes step status. It carries no verdict; the persisted review row remains the sole
// verdict source.
function runningWorkflowRunForPull(
  repoId: number,
  prNumber: number,
): S.WorkflowRunRow | null {
  for (const run of S.listRunningWorkflowRuns()) {
    if (run.repo_id === repoId && run.pr_number === prNumber) return run;
  }
  return null;
}

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

  async create(
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
    // Bind the review to the live head it was made against. The watcher-backed
    // stored SHA can lag immediately after a rebase, so it is only a fallback
    // when the ref cannot be resolved. Workflow placement may pass its pinned
    // SHA explicitly and must keep taking precedence.
    const pull = S.getPull(row.id)!;
    const submissionHeadSha =
      (await revParse(r.local_path, pull.head_ref)) ?? pull.head_sha ?? null;
    const headSha = input.headSha ?? submissionHeadSha;
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
    const workflowRun =
      event === "PASS" || event === "REQUEST_CHANGES" || event === "FEEDBACK"
        ? runningWorkflowRunForPull(r.id, row.number)
        : null;
    if (workflowRun) {
      // The review row remains the sole verdict source. This run-scoped event is only the reliable
      // observation trigger for the parent, independent of whether the Verify child later manages
      // to declare its turn done. `review_id` lets the parent hand an out-of-band (e.g. human/crit
      // FEEDBACK) review straight to Execute, since it will not appear in the run's own step status.
      S.emitEvent(r.id, "workflow_run.review_submitted", actor, {
        id: workflowRun.id,
        number: workflowRun.pr_number,
        issue_number: workflowRun.issue_number,
        pr_number: workflowRun.pr_number,
        parent_session_id: workflowRun.parent_session_id,
        session_id: sessionId ?? null,
        review_id: v.id,
        submission_head_sha: submissionHeadSha,
      });
    }
    return { ...reviewJSON(v), comments: lineComments.length };
  },
};
