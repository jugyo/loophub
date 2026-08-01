import { createHash } from "node:crypto";
import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { handoffJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

// ===== handoffs (#352) =====
//
// The orchestrator<->subagent handoff bus, made durable. A handoff is
// one explicit document — a parent's instruction (direction="down") or a child's return ("up") —
// recorded out of the volatile conversation so a run's trajectory can be replayed and evaluated.
// Generic by design: any orchestration records through this same procedure; no
// orchestration-specific field is required.
//
// Linkage: a handoff binds to a PR (`pr`) and/or a generic issue (`issue`) — at least one — plus
// the recording session (the attribution sessionId), so it naturally hangs off "PR + session". The
// body is HYBRID: pass `body` for content with no other home (the instruction prompt, the Verify
// report), or `src` to reference a canonical copy living elsewhere (plan=PR, diff=commit) without
// duplicating it. Exactly one of (body, src) carries the substance. When inline, `hash` defaults to
// the sha256 of `body` for integrity; with `src` the caller supplies `hash` (the referenced
// content's hash). Security: rows persist unencrypted and are never GC'd, so the
// caller must keep secrets out (this layer validates shape, not secrecy). The body may also carry
// issue-derived (untrusted) text, and `lh handoff list` reads it back into an orchestrator's
// context: consumers MUST treat a recorded body as DATA, never as instructions to act on. The
// broadcast `handoff.recorded` event therefore carries only metadata (seq/phase/direction), never
// the body, so untrusted content is not propagated through event consumers.
export const HANDOFF_DIRECTIONS = ["down", "up"] as const;
export type HandoffDirection = (typeof HANDOFF_DIRECTIONS)[number];

export const handoffs = {
  record(
    name: string,
    input: {
      phase: string;
      direction: string;
      pr?: number;
      issue?: number;
      from?: string;
      to?: string;
      body?: string;
      src?: string;
      hash?: string;
      summary?: string;
      model?: string;
      cost?: string;
    },
    sessionId?: string | null,
  ): any {
    const r = repoOr404(name);
    ensureWritable(r);

    const phase = (input.phase ?? "").trim();
    if (!phase) throw new ServiceError(422, "phase is required");
    if (!HANDOFF_DIRECTIONS.includes(input.direction as HandoffDirection)) {
      throw new ServiceError(
        422,
        `invalid direction "${input.direction}" (expected one of: ${HANDOFF_DIRECTIONS.join(", ")})`,
      );
    }
    const direction = input.direction as HandoffDirection;

    // Body XOR src: exactly one carries the substance. An empty/whitespace value counts as absent.
    const body = input.body?.trim() ? input.body : undefined;
    const src = input.src?.trim() || undefined;
    if (!body && !src) {
      throw new ServiceError(422, "one of body or src is required");
    }
    if (body && src) {
      throw new ServiceError(
        422,
        "pass only one of body or src (inline content vs a reference)",
      );
    }

    if (input.pr == null && input.issue == null) {
      throw new ServiceError(422, "one of pr or issue is required");
    }
    let prId: number | undefined;
    let prNumber: number | undefined;
    if (input.pr != null) {
      const prRow = issueOr404(r, input.pr, "pull");
      prId = prRow.id;
      prNumber = prRow.number;
    }
    let issueId: number | undefined;
    let issueNumber: number | undefined;
    if (input.issue != null) {
      const issueRow = issueOr404(r, input.issue, "issue");
      issueId = issueRow.id;
      issueNumber = issueRow.number;
    }

    // Link the recording session only when it is registered: handoffs.session_id has an FK to
    // agent_sessions (foreign_keys is ON), so an unregistered attribution id would abort the
    // insert. The actor line still uses sessionId regardless (authorFromSession tolerates absence).
    const sessionLink =
      sessionId && S.getAgentSession(sessionId) ? sessionId : null;

    // Content hash: an explicit --hash wins (the referenced canonical's hash); otherwise, for an
    // inline body, default to its sha256 so the record is self-verifying. A pure reference with no
    // supplied hash stays null.
    const hash =
      input.hash?.trim() ||
      (body ? createHash("sha256").update(body).digest("hex") : undefined);

    return db.transaction(() => {
      const row = S.createHandoff({
        repoId: r.id,
        prId,
        issueId,
        sessionId: sessionLink,
        phase,
        direction,
        fromRole: input.from?.trim() || undefined,
        toRole: input.to?.trim() || undefined,
        body,
        src,
        hash,
        summary: input.summary?.trim() || undefined,
        model: input.model?.trim() || undefined,
        cost: input.cost?.trim() || undefined,
      });

      // Emit a PR-scoped event so polling refreshes the PR detail's handoff section. payload.number
      // is the PR number (the routing key event-keys.ts maps to the pull detail); pr_number is a
      // duplicate for consumers that read it. For an issue-only handoff there is no PR to scope to.
      S.emitEvent(r.id, "handoff.recorded", actorFor(sessionId), {
        ...(prNumber != null ? { number: prNumber, pr_number: prNumber } : {}),
        ...(issueNumber != null ? { issue_number: issueNumber } : {}),
        id: row.id,
        seq: row.seq,
        phase,
        direction,
      });
      return handoffJSON(row);
    });
  },

  list(
    name: string,
    opts: { pr?: number; issue?: number; session?: string } = {},
  ): any[] {
    const r = repoOr404(name);
    const filter: { prId?: number; issueId?: number; sessionId?: string } = {};
    if (opts.pr != null) {
      filter.prId = issueOr404(r, opts.pr, "pull").id;
    }
    if (opts.issue != null) {
      filter.issueId = issueOr404(r, opts.issue, "issue").id;
    }
    if (opts.session != null) {
      filter.sessionId = opts.session;
    }
    return S.listHandoffs(r.id, filter).map(handoffJSON);
  },
};
