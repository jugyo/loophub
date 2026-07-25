import { ServiceError } from "../errors.ts";
import {
  isRetroStatus,
  RetroValidationError,
  validateFindings,
  validateRubric,
} from "../retro.ts";
import { retroJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

// ===== retros (loop retrospectives) =====
//
// Persist a generated retro (rubric scores + free-form findings) for a PR and emit
// `session.retro.created` (loop-retrospective-design.ja.md §4). The skill (`/lh-retro`)
// gathers LoopHub data and produces the rubric/findings; this procedure validates the
// shapes, resolves the PR -> linked issue -> implementation session chain, writes the
// row, and emits the event. Keeping the orchestration here (CLI stays thin) follows the
// core/cli responsibility split.

export const DEFAULT_RETRO_BACKLOG_LIMIT = 20;
export const MAX_RETRO_BACKLOG_LIMIT = 100;

export const retros = {
  create(
    name: string,
    input: {
      pr: number;
      rubric: unknown;
      findings: unknown;
      status?: string;
      redacted?: boolean;
      redact_ruleset?: string | null;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const prRow = issueOr404(r, input.pr, "pull");

    let rubric: ReturnType<typeof validateRubric>;
    let findings: ReturnType<typeof validateFindings>;
    try {
      rubric = validateRubric(input.rubric);
      findings = validateFindings(input.findings);
    } catch (e) {
      if (e instanceof RetroValidationError)
        throw new ServiceError(422, e.message);
      throw e;
    }

    const status = input.status ?? "draft";
    if (!isRetroStatus(status)) {
      throw new ServiceError(
        422,
        `invalid status "${status}" (expected draft|reviewed|applied|dismissed)`,
      );
    }

    // PR -> implementation session (design §4.3.1). The session is the PR's latest kind='dev' link
    // in session_links (primaryDevSessionForPull, #316); issue_id still records the linked issue for
    // the retro. Any link may be absent: a PR with no session/link keeps those NULL and the retro
    // still stands on event/PR data alone.
    const pull = S.getPull(prRow.id);
    const issueId: number | null = pull?.linked_issue_id ?? null;
    const linkedIssue = issueId != null ? S.getIssueById(issueId) : null;
    const implSession: string | null = S.primaryDevSessionForPull(prRow.id);

    const actor = actorFor(sessionId);
    const row = S.createRetro({
      repoId: r.id,
      issueId,
      prId: prRow.id,
      sessionId: implSession,
      rubricJson: JSON.stringify(rubric),
      findingsJson: JSON.stringify(findings),
      status,
      redacted: input.redacted,
      redactRuleset: input.redact_ruleset ?? null,
    });

    const payload: {
      retro_id: number;
      pr_number: number;
      issue_number?: number;
      session_id?: string;
      status: string;
    } = { retro_id: row.id, pr_number: prRow.number, status };
    if (linkedIssue?.number != null) payload.issue_number = linkedIssue.number;
    if (implSession) payload.session_id = implSession;
    S.emitEvent(r.id, "session.retro.created", actor, payload);

    return retroJSON(row);
  },

  list(name: string, opts: { pr?: number; status?: string } = {}) {
    const r = repoOr404(name);
    let prId: number | null = null;
    if (opts.pr != null) {
      prId = issueOr404(r, opts.pr, "pull").id;
    }
    if (opts.status !== undefined && !isRetroStatus(opts.status)) {
      throw new ServiceError(
        422,
        `invalid status "${opts.status}" (expected draft|reviewed|applied|dismissed)`,
      );
    }
    return S.listRetros(r.id, { prId, status: opts.status }).map(retroJSON);
  },

  get(name: string, id: number) {
    const r = repoOr404(name);
    const row = S.getRetroById(id);
    if (!row || row.repo_id !== r.id) throw new ServiceError(404, "Not Found");
    return retroJSON(row);
  },

  // Backfill helper: merged PRs in the repo with no retro yet (design §5.1).
  pending(name: string, opts: { limit?: number } = {}) {
    const r = repoOr404(name);
    let limit = Number(opts.limit ?? DEFAULT_RETRO_BACKLOG_LIMIT);
    if (!Number.isFinite(limit) || limit < 1)
      limit = DEFAULT_RETRO_BACKLOG_LIMIT;
    limit = Math.min(limit, MAX_RETRO_BACKLOG_LIMIT);
    return S.mergedPullsWithoutRetro(r.id, limit).map((row) => ({
      number: row.number,
      title: row.title,
      merged_at: row.merged_at ?? null,
    }));
  },
};
