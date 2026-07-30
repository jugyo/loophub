import { ServiceError } from "../errors.ts";
import { revParse } from "../git.ts";
import {
  type ReviewAcResultWire,
  reviewCommentJSON,
  reviewJSON,
} from "../serialize.ts";
import * as S from "../store.ts";
import { SOURCE_PAYLOAD_VERSION } from "../workflow/source-events.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

// The per-criterion grades of one review (#1895), joined to the rubric text via `criterion_id`.
// A criterion disabled after grading still resolves here (grade rows are never deleted). Shared by
// every surface that shows grades — the review wire and the workflow run summary — so the join
// lives in one place.
export function reviewAcResultsJSON(reviewId: number): ReviewAcResultWire[] {
  return S.listReviewAcResults(reviewId).map((r) => {
    const criterion = S.getAcceptanceCriterion(r.criterion_id);
    return {
      criterion_id: r.criterion_id,
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
  input:
    | { criterion_id: number | string; verdict: string; note?: string }[]
    | undefined,
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
    if (typeof criterionRef === "number" && Number.isInteger(criterionRef)) {
      criterionId = criterionRef;
    } else if (
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
        "each ac-result requires criterion_id as a stable integer id or <issue-number>-<ac-number>",
      );
    }
    if (r.verdict !== "pass" && r.verdict !== "fail")
      throw new ServiceError(
        422,
        `ac-result verdict must be 'pass' or 'fail' (criterion ${criterionId})`,
      );
    if (!enabledIds.has(criterionId))
      throw new ServiceError(
        422,
        `criterion ${criterionId} is not an enabled acceptance criterion of the linked issue`,
      );
    if (seen.has(criterionId))
      throw new ServiceError(
        422,
        `duplicate ac-result for criterion ${criterionId}`,
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
        criterion_id: number | string;
        verdict: string;
        note?: string;
      }[];
    },
    sessionId?: string | null,
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
    const actor = actorFor(sessionId);
    // Bind the review to the live head it was made against. The watcher-backed
    // stored SHA can lag immediately after a rebase, so it is only a fallback
    // when the ref cannot be resolved. Workflow placement may pass its pinned
    // SHA explicitly and must keep taking precedence.
    const pull = S.getPull(row.id)!;
    const submissionHeadSha =
      (await revParse(r.local_path, pull.head_ref)) ?? pull.head_sha ?? null;
    const headSha = input.headSha ?? submissionHeadSha;
    // The review row and its per-criterion grades are written in one transaction so a review never
    // exists without the grades it carries (#1895). Line comments stay separate, as before.
    const v = S.createReviewWithAcResults(
      row.id,
      actor,
      event,
      input.body ?? "",
      headSha,
      model,
      acResults,
    );
    for (const cm of lineComments) {
      S.createReviewComment(row.id, v.id, actor, {
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
    return {
      ...reviewJSON(v, reviewAcResultsJSON(v.id)),
      comments: lineComments.length,
      warnings: verdictWarnings(event, acResults),
    };
  },
};
