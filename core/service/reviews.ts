import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { localBranchRef, revParse } from "../git.ts";
import {
  acceptanceCriterionDisplayId,
  type ReviewAcResultWire,
  type ReviewDetailWire,
  reviewCommentJSON,
  reviewJSON,
  reviewResponseJSON,
} from "../serialize.ts";
import * as S from "../store.ts";
import { workflowStepSessionIds } from "../workflow/herdr-agents.ts";
import { SOURCE_PAYLOAD_VERSION } from "../workflow/source-events.ts";
import {
  actorFor,
  commentActor,
  ensureWritable,
  issueOr404,
  repoOr404,
} from "./shared.ts";

const FULL_SHA = /^[0-9a-f]{40}$/i;

interface ReviewCreateDeps {
  revParse: typeof revParse;
}

const realReviewCreateDeps: ReviewCreateDeps = { revParse };

// The per-criterion grades of one review (#1895), joined to the rubric text via `criterion_id`.
// A criterion disabled after grading still resolves here (grade rows are never deleted). Shared by
// every surface that shows grades — the review wire and the workflow run summary — so the join
// lives in one place.
export function reviewAcResultsJSON(reviewId: number): ReviewAcResultWire[] {
  return S.listReviewAcResults(reviewId).map((r) => {
    const criterion = S.getAcceptanceCriterion(r.criterion_id);
    const issue = criterion ? S.getIssueById(criterion.issue_id) : null;
    return {
      criterion_id:
        criterion && issue
          ? acceptanceCriterionDisplayId(issue.number, criterion.number)
          : "unknown",
      number: criterion?.number ?? 0,
      text: criterion?.text ?? "",
      verdict: r.verdict === "pass" ? "pass" : "fail",
      note: r.note,
    };
  });
}

// Validate submitted per-criterion grades against the PR's linked issue rubric (#1895). The rubric
// is the enabled `acceptance_criteria` of the issue the PR closes (grades hang off criterion ids,
// which live on the issue, not the PR row). We reject — never silently correct — a grade for an
// unknown/disabled criterion, a duplicate, an invalid verdict, or a partial/oversized set that does
// not cover exactly the enabled criteria. `undefined` means no structured grading (holistic).
function validateAcResults(
  prRow: S.IssueRow,
  input: { criterion_id: string; verdict: string; note?: string }[] | undefined,
): { criterionId: number; verdict: string; note: string }[] {
  if (input === undefined) return [];
  if (!Array.isArray(input))
    throw new ServiceError(422, "ac-results must be an array");
  const pull = S.getPull(prRow.id);
  const linkedIssue =
    pull?.linked_issue_id != null ? S.getIssueById(pull.linked_issue_id) : null;
  const enabledIds = new Set(
    pull?.linked_issue_id != null
      ? S.listAcceptanceCriteria(pull.linked_issue_id)
          .filter((c) => c.enabled === 1)
          .map((c) => c.id)
      : [],
  );
  const seen = new Set<number>();
  const results = input.map((r) => {
    const criterionRef = r?.criterion_id;
    let criterionId: number;
    if (
      typeof criterionRef === "string" &&
      /^([1-9]\d*)-([1-9]\d*)$/.test(criterionRef)
    ) {
      const [, issueNumber, criterionNumber] = criterionRef.match(
        /^([1-9]\d*)-([1-9]\d*)$/,
      )!;
      const referencedIssue = S.getIssue(prRow.repo_id, Number(issueNumber));
      if (!referencedIssue) {
        throw new ServiceError(404, `issue #${issueNumber} not found`);
      }
      if (!linkedIssue || linkedIssue.id !== referencedIssue.id) {
        throw new ServiceError(
          422,
          `issue #${issueNumber} is not the issue linked to this pull request`,
        );
      }
      const criterion = S.getAcceptanceCriterionByNumber(
        linkedIssue.id,
        Number(criterionNumber),
      );
      if (!criterion) {
        throw new ServiceError(
          404,
          `acceptance criterion ${criterionRef} not found`,
        );
      }
      criterionId = criterion.id;
    } else {
      throw new ServiceError(
        422,
        "each ac-result requires criterion_id as <issue-number>-<ac-number>",
      );
    }
    if (r.verdict !== "pass" && r.verdict !== "fail")
      throw new ServiceError(
        422,
        `ac-result verdict must be 'pass' or 'fail' (criterion ${criterionRef})`,
      );
    if (!enabledIds.has(criterionId))
      throw new ServiceError(
        422,
        `criterion ${criterionRef} is not an enabled acceptance criterion of the linked issue`,
      );
    if (seen.has(criterionId))
      throw new ServiceError(
        422,
        `duplicate ac-result for criterion ${criterionRef}`,
      );
    seen.add(criterionId);
    return { criterionId, verdict: r.verdict, note: r.note ?? "" };
  });
  // Reject a set that does not cover exactly the enabled criteria (件数過不足). Membership + no-dup
  // above already bound the set within the rubric, so an equal count means an exact 1:1 grading.
  if (results.length !== enabledIds.size)
    throw new ServiceError(
      422,
      `ac-results must grade every enabled acceptance criterion exactly once (expected ${enabledIds.size}, got ${results.length})`,
    );
  return results;
}

// The verdict and its grades can contradict each other: `PASS` means every criterion passed (#1896
// aggregation rule), so a failing grade alongside it is an internal inconsistency. This is a
// soft-warn by design — we record the submission as made and return a visible warning so a human
// notices, rather than hard-rejecting a review the agent already reasoned about.
function verdictWarnings(
  event: string,
  acResults: { verdict: string }[],
): string[] {
  const failed = acResults.filter((r) => r.verdict === "fail").length;
  return event === "PASS" && failed > 0
    ? [
        `event=PASS was submitted with ${failed} failing acceptance criterion grade(s); a pass requires every criterion to pass`,
      ]
    : [];
}

// A replacement Verify is allowed to launch even when stopping its predecessor fails. As soon as
// the replacement owns the launch reservation (and after it is confirmed in session history), the
// predecessor may no longer submit a review that could move the PR gate or Workflow state ahead of
// the replacement. Callers check once before git work for a fast failure and again inside the write
// transaction to close the asynchronous race.
function assertCurrentWorkflowVerifier(
  repoId: number,
  prNumber: number,
  sessionId: string | null | undefined,
): void {
  if (!sessionId) return;
  const run = S.runningWorkflowRunForSession(repoId, prNumber, sessionId);
  if (!run) return;
  const verifySessions = workflowStepSessionIds(
    run.step_sessions_json,
    "verify",
  );
  if (!verifySessions.includes(sessionId)) return;
  const currentSessionId =
    run.launching_step === "verify" && run.launching_session_id
      ? run.launching_session_id
      : verifySessions.at(-1);
  if (currentSessionId !== sessionId) {
    throw new ServiceError(
      409,
      "Workflow Verify session was superseded by a later launch",
    );
  }
}

// ===== reviews =====
export const reviews = {
  list(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return S.listReviews(row.id).map((v) =>
      reviewJSON(v, reviewAcResultsJSON(v.id)),
    );
  },

  listComments(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return S.listReviewComments(row.id).map(reviewCommentJSON);
  },

  get(name: string, number: number, reviewId: number): ReviewDetailWire {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const review = S.listReviews(row.id).find(
      (candidate) => candidate.id === reviewId,
    );
    if (!review) {
      throw new ServiceError(
        404,
        `review #${reviewId} not found on PR #${number}`,
      );
    }
    return {
      review: reviewJSON(review, reviewAcResultsJSON(review.id)),
      comments: S.listReviewComments(row.id)
        .filter((comment) => comment.review_id === review.id)
        .map(reviewCommentJSON),
    };
  },

  listResponses(name: string, number: number, reviewId?: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    if (
      reviewId !== undefined &&
      !S.listReviews(row.id).some((review) => review.id === reviewId)
    ) {
      throw new ServiceError(
        404,
        `review #${reviewId} not found on PR #${number}`,
      );
    }
    return S.listReviewResponses(row.id, reviewId).map(reviewResponseJSON);
  },

  createResponse(
    name: string,
    number: number,
    input: { reviewId: number; reviewCommentId?: number; body: string },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const review = S.listReviews(row.id).find(
      (candidate) => candidate.id === input.reviewId,
    );
    if (!review) {
      throw new ServiceError(
        404,
        `review #${input.reviewId} not found on PR #${number}`,
      );
    }
    if (!input.body.trim()) {
      throw new ServiceError(422, "review response body is required");
    }
    const reviewCommentId = input.reviewCommentId ?? null;
    if (
      reviewCommentId !== null &&
      !S.listReviewComments(row.id).some(
        (comment) =>
          comment.id === reviewCommentId && comment.review_id === review.id,
      )
    ) {
      throw new ServiceError(
        404,
        `review comment #${reviewCommentId} not found on review #${review.id}`,
      );
    }
    const actor = actorFor(sessionId);
    const response = S.createReviewResponse(
      row.id,
      review.id,
      reviewCommentId,
      actor,
      input.body,
    );
    S.emitEvent(r.id, "pull_request.review_response_created", actor, {
      number: row.number,
      review_id: review.id,
      review_comment_id: reviewCommentId,
      response_id: response.id,
    });
    return reviewResponseJSON(response);
  },

  async create(
    name: string,
    number: number,
    input: {
      event?: string;
      body?: string;
      model?: string;
      headSha?: string;
      comments?: { path: string; line?: number; side?: string; body: string }[];
      acResults?: {
        criterion_id: string;
        verdict: string;
        note?: string;
      }[];
    },
    sessionId?: string | null,
    deps: ReviewCreateDeps = realReviewCreateDeps,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    let event = (input.event ?? "COMMENT").toUpperCase();
    // Back-compat: pre-#428 callers still pass "approve" (the old vocabulary).
    if (event === "APPROVE") event = "PASS";
    // The agent/model that produced the review (#1107). Free-form; a blank model
    // is stored as NULL (unattributed), preserving pre-#1107 behavior.
    const model = input.model?.trim() || null;
    const lineComments = Array.isArray(input.comments) ? input.comments : [];
    for (const cm of lineComments) {
      if (!cm?.path || !cm?.body)
        throw new ServiceError(422, "each comment requires path and body");
    }
    // Per-criterion grades (#1895). Omitting `acResults` is the holistic fallback (no structured
    // grading, zero grade rows); providing it means grading the linked issue's enabled rubric. We
    // validate ownership and coverage here and reject with a visible error rather than silently
    // correcting (CLAUDE.md「可視エラーを優先」).
    const acResults = validateAcResults(row, input.acResults);
    if (input.headSha !== undefined && !FULL_SHA.test(input.headSha)) {
      throw new ServiceError(
        422,
        "head-sha は 40 文字の 16 進数 SHA で指定してください",
      );
    }
    const { actor, authorType } = commentActor(sessionId);
    if (authorType === "agent") {
      assertCurrentWorkflowVerifier(r.id, row.number, sessionId);
    }
    // Bind the review to the agent session that submitted it (#2387): that session exists to
    // produce this one review, so its start is when the review began — what grounds the reported
    // duration. Only an agent session qualifies. `commentActor` resolved the row already, so this
    // also rejects an id with no session (an unknown id would break the foreign key) and, crucially,
    // the CLI's human session: that one is persistent — a single row per LOOPHUB_HOME, reused by
    // every human write forever (cli/context.ts ensureHumanSession) — so its start marks when the
    // home was created, not when anyone started reviewing. Recording it would report the home's age
    // as the review's duration. A human review therefore stores no session and reports no duration.
    const reviewSessionId = authorType === "agent" ? (sessionId ?? null) : null;
    // Bind the review to the live head it was made against. The watcher-backed
    // stored SHA can lag immediately after a rebase, so it is only a fallback
    // when the ref cannot be resolved. Workflow placement may pass its pinned
    // SHA explicitly and must keep taking precedence.
    const pull = S.getPull(row.id)!;
    const submissionHeadSha =
      (await deps.revParse(r.local_path, localBranchRef(pull.head_ref))) ??
      pull.head_sha ??
      null;
    const headSha = input.headSha ?? submissionHeadSha;
    // The head SHA read above is the last git call; the review row, its per-criterion grades, its
    // line comments and the submission event all commit together (#1895), so a review never exists
    // without the grades, comments or event it carries.
    const wire = db.transaction(() => {
      // revParse above is asynchronous. A replacement can reserve its launch while this review is
      // waiting, so repeat the verifier check inside the transaction immediately before the first
      // write. The reservation and verdict now have one serial order.
      if (authorType === "agent") {
        assertCurrentWorkflowVerifier(r.id, row.number, sessionId);
      }
      const v = S.createReviewWithAcResults(
        row.id,
        actor,
        event,
        input.body ?? "",
        headSha,
        model,
        acResults,
        authorType,
        reviewSessionId,
      );
      for (const cm of lineComments) {
        S.createReviewComment(row.id, v.id, actor, authorType, {
          path: cm.path,
          line: cm.line,
          side: cm.side,
          body: cm.body,
        });
      }
      // The review row remains the sole verdict source. This event is the reliable observation
      // trigger for a Workflow parent, independent of whether the Verify child later manages to
      // declare its turn done. `review_id` lets the parent hand an out-of-band (e.g. human FEEDBACK)
      // review straight to Execute, since it will not appear in the run's own step status, and
      // `submission_head_sha` is the boundary an unaddressed review is measured from.
      S.emitEvent(r.id, "pull_request.review_submitted", actor, {
        number: row.number,
        state: event,
        comments: lineComments.length,
        session_id: sessionId ?? null,
        review_id: v.id,
        submission_head_sha: submissionHeadSha,
        source_payload_version: SOURCE_PAYLOAD_VERSION,
      });
      return reviewJSON(v, reviewAcResultsJSON(v.id));
    });
    return {
      ...wire,
      comments: lineComments.length,
      warnings: verdictWarnings(event, acResults),
    };
  },
};
