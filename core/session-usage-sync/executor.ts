import { db } from "../db.ts";
import { sessionUsageJSON } from "../serialize.ts";
import * as S from "../store.ts";
import {
  modelUsageEqualsStored,
  type SessionUsagePlan,
  type SessionUsageSyncCohort,
  type SessionUsageSyncRow,
  usageCursorEquals,
} from "./plan.ts";

// A plan is built from state read before the transaction opened. When that state has moved on, the
// dedupe rows, usage totals and transcript cursor would disagree with each other, so the cohort is
// abandoned and the next sweep replans from the current state.
const STALE_PLAN_MESSAGE = "Session usage changed during sync";

/**
 * Apply planned changes, one transaction per cohort. Every expectation in the cohort is re-checked
 * before the first write, so a stale plan cannot leave its peers partially updated.
 *
 * Returns the report row for each planned session, keyed by session id.
 */
export function applySessionUsageSync(
  cohorts: readonly SessionUsageSyncCohort[],
): Map<string, SessionUsageSyncRow> {
  const results = new Map<string, SessionUsageSyncRow>();
  for (const cohort of cohorts) {
    db.transaction(() => {
      for (const plan of cohort.plans) assertPlannedState(plan);
      for (const plan of cohort.plans) {
        results.set(plan.sessionId, applyPlan(plan));
      }
    });
  }
  return results;
}

function assertPlannedState(plan: SessionUsagePlan): void {
  const expect = plan.expect;
  if (!expect) return;
  if (
    expect.usage &&
    !modelUsageEqualsStored(expect.usage, S.listSessionUsage(plan.sessionId))
  ) {
    throw new Error(STALE_PLAN_MESSAGE);
  }
  if (
    expect.cursor !== undefined &&
    !usageCursorEquals(expect.cursor, S.getSessionUsageCursor(plan.sessionId))
  ) {
    throw new Error(STALE_PLAN_MESSAGE);
  }
}

function applyPlan(plan: SessionUsagePlan): SessionUsageSyncRow {
  const { sessionId } = plan;
  if (plan.externalSession) {
    S.setAgentSessionExternalSession(sessionId, plan.externalSession);
    const updated = S.getAgentSession(sessionId)!;
    S.emitEvent(null, "agent_session.updated", updated.agent, {
      id: updated.id,
      agent: updated.agent,
      session: updated.external_session,
      ...(updated.runtime ? { runtime: updated.runtime } : {}),
      ...(updated.kind ? { kind: updated.kind } : {}),
      ...(updated.model ? { model: updated.model } : {}),
    });
  }
  if (plan.resetUsage) S.resetSessionUsage(sessionId);
  for (const peer of plan.clearUsageFor ?? []) S.resetSessionUsage(peer);
  for (const messageId of plan.messageIds ?? []) {
    if (!S.insertSessionUsageMessage(sessionId, messageId)) {
      throw new Error(STALE_PLAN_MESSAGE);
    }
  }
  for (const usage of plan.usage ?? []) S.upsertSessionUsage(sessionId, usage);
  for (const cost of plan.usageCosts ?? []) {
    S.rewriteSessionUsageCost(sessionId, cost.model, cost.costUsd);
  }
  if (plan.subagents) {
    if (plan.subagents.deleteKind) {
      S.deleteSessionSubagentUsageByKind(sessionId, plan.subagents.deleteKind);
    }
    for (const row of plan.subagents.rows) {
      S.upsertSessionSubagentUsage(sessionId, row);
    }
  }
  if (plan.cursor) S.upsertSessionUsageCursor({ sessionId, ...plan.cursor });

  return {
    session_id: sessionId,
    status: plan.report.status,
    ...(plan.report.transcriptPath !== undefined
      ? { transcript_path: plan.report.transcriptPath }
      : {}),
    messages: plan.report.messages,
    models:
      plan.report.models === "stored"
        ? S.listSessionUsage(sessionId).map(sessionUsageJSON)
        : [],
  };
}
