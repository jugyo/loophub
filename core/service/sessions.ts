import { CODING_AGENTS, type CodingAgent } from "../config.ts";
import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { isCodingAgent } from "../runtimes.ts";
import {
  type AgentCostSummaryWire,
  agentSessionJSON,
  sessionUsageJSON,
} from "../serialize.ts";
import { sessionRuntime } from "../session-runtime.ts";
import {
  applySessionUsageSync,
  planSessionUsageSync,
  type SessionUsageSyncOptions,
  type SessionUsageSyncRow,
} from "../session-usage-sync/index.ts";
import * as S from "../store.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

interface UsageSyncInput extends SessionUsageSyncOptions {
  sessionId?: string;
}

export type {
  SessionUsageSyncRow,
  SessionUsageSyncStatus,
} from "../session-usage-sync/index.ts";

export interface SessionUsageSyncResult {
  synced: number;
  skipped: number;
  missing: number;
  sessions: SessionUsageSyncRow[];
}

type PeriodKey = "month" | "week" | "day";

function periodStarts(now: Date): Record<PeriodKey, number> {
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day);
  const dayOfWeek = week.getDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  week.setDate(day.getDate() - daysSinceMonday);
  return {
    month: month.getTime(),
    week: week.getTime(),
    day: day.getTime(),
  };
}

function sessionPeriodCosts(
  sessionId: string,
  starts: Record<PeriodKey, number>,
): Record<PeriodKey, number | null> {
  const out: Record<PeriodKey, number | null> = { month: 0, week: 0, day: 0 };
  const usage = S.listSessionUsage(sessionId);
  for (const row of usage) {
    const updatedAt = Date.parse(row.updated_at);
    if (!Number.isFinite(updatedAt)) continue;
    for (const period of ["month", "week", "day"] as const) {
      if (updatedAt < starts[period]) continue;
      out[period] = addCost(out[period], row.cost_usd);
    }
  }
  return out;
}

function addCost(current: number | null, next: number | null): number | null {
  if (current === null || next === null) return null;
  return current + next;
}

export const sessions = {
  // Thin pass-throughs so callers outside core/ (lh-worker's usage sweep) don't reach into
  // core/store directly.
  authorFromSession(sessionId: string | null | undefined): string | null {
    return S.authorFromSession(sessionId);
  },

  linkedTargets(sessionId: string): S.SessionLinkedTargetRow[] {
    return S.listSessionLinkedTargets(sessionId);
  },

  workflowUsageTarget(repoId: number, prNumber: number, sessionId: string) {
    const run = S.runningWorkflowRunForSession(repoId, prNumber, sessionId);
    return run
      ? { runId: run.id, parentSessionId: run.parent_session_id }
      : null;
  },

  register(input: {
    id: string;
    agent: string;
    session: string;
    name?: string | null;
    runtime?: string | null;
    kind?: string | null;
    model?: string | null;
  }) {
    const { id, agent, session, name, runtime, kind, model } = input;
    if (!id || !agent || !session)
      throw new ServiceError(422, "id, agent, and session are required");
    try {
      // Pass name/runtime/kind straight through (not `?? null`): the store INSERT path applies
      // `?? null` for new rows, while its UPDATE path preserves the existing value when the arg is
      // undefined. Forcing undefined → null here would defeat that preserve-on-re-register contract.
      return db.transaction(() => {
        const { session: row, created } = S.registerAgentSession(
          id,
          agent,
          session,
          name,
          runtime,
          kind,
          model,
        );
        S.emitEvent(
          null,
          created ? "agent_session.registered" : "agent_session.updated",
          agent,
          {
            id: row.id,
            agent: row.agent,
            session: row.external_session,
            ...(row.name ? { name: row.name } : {}),
            ...(row.runtime ? { runtime: row.runtime } : {}),
            ...(row.kind ? { kind: row.kind } : {}),
            ...(row.model ? { model: row.model } : {}),
          },
        );
        return { session: agentSessionJSON(row), created };
      });
    } catch (e: any) {
      if (e.message === "CONFLICT_ID" || e.message === "CONFLICT_PAIR") {
        throw new ServiceError(409, "Agent session conflict");
      }
      throw e;
    }
  },

  recordExternalSession(input: { sessionId: string; externalSession: string }) {
    const row = S.getAgentSession(input.sessionId);
    const externalSession = input.externalSession.trim();
    if (!row) throw new ServiceError(404, "Not Found");
    if (!externalSession) {
      throw new ServiceError(422, "externalSession is required");
    }
    return db.transaction(() => {
      S.setAgentSessionExternalSession(row.id, externalSession);
      const updated = S.getAgentSession(row.id)!;
      S.emitEvent(null, "agent_session.updated", row.agent, {
        id: updated.id,
        agent: updated.agent,
        session: updated.external_session,
        ...(updated.runtime ? { runtime: updated.runtime } : {}),
        ...(updated.kind ? { kind: updated.kind } : {}),
        ...(updated.model ? { model: updated.model } : {}),
      });
      return agentSessionJSON(updated);
    });
  },

  // Link an already-registered session to an issue or a PR (#298). The generalized attach point for
  // session kinds beyond dev (review, issue-create, …): the launch flows for those kinds live in
  // their own issues, but the base records the link here. Idempotent (the bridge PK is the pair).
  // `target` is { issue } or { pr } — a number resolved against the repo. Emits `agent_session.linked`.
  link(
    name: string,
    input: { sessionId: string; issue?: number; pr?: number },
  ): { session_id: string; issue_number?: number; pr_number?: number } {
    const r = repoOr404(name);
    ensureWritable(r);
    const { sessionId, issue, pr } = input;
    if (!sessionId) throw new ServiceError(422, "sessionId is required");
    if ((issue == null) === (pr == null))
      throw new ServiceError(422, "exactly one of issue or pr is required");
    if (!S.getAgentSession(sessionId))
      throw new ServiceError(404, "Agent session not found");
    const targetKind = issue != null ? "issue" : "pull";
    const number = (issue ?? pr) as number;
    const row = issueOr404(r, number, targetKind);
    db.transaction(() => {
      S.linkSession(sessionId, row.id);
      // `agent_session.*` namespace (matches register's agent_session.registered/updated) so the
      // web event-key router (web/src/lib/event-keys.ts startsWith "agent_session.") invalidates the
      // agent-sessions queries on a link too.
      S.emitEvent(r.id, "agent_session.linked", actorFor(sessionId), {
        session_id: sessionId,
        [targetKind === "pull" ? "pr" : "issue"]: row.number,
      });
    });
    return {
      session_id: sessionId,
      ...(targetKind === "pull"
        ? { pr_number: row.number }
        : { issue_number: row.number }),
    };
  },

  list() {
    return S.listAgentSessions()
      .map((row) => agentSessionJSON(row, { withLinkedTargets: true }))
      .filter((session) => (session.usage?.length ?? 0) > 0);
  },

  costSummary(now = new Date()): AgentCostSummaryWire[] {
    const starts = periodStarts(now);
    const byAgent = new Map<CodingAgent, AgentCostSummaryWire>();
    for (const agent of CODING_AGENTS) {
      byAgent.set(agent, { agent, month: 0, week: 0, day: 0 });
    }

    for (const session of S.listAgentSessions()) {
      const runtime = sessionRuntime(session);
      const agent = isCodingAgent(runtime) ? runtime : null;
      if (!agent) continue;
      const costs = sessionPeriodCosts(session.id, starts);
      const summary = byAgent.get(agent)!;
      for (const period of ["month", "week", "day"] as const) {
        summary[period] = addCost(summary[period], costs[period]);
      }
    }

    return CODING_AGENTS.map((agent) => byAgent.get(agent)!);
  },

  usage(id?: string) {
    if (id) {
      if (!S.getAgentSession(id)) throw new ServiceError(404, "Not Found");
      return S.listSessionUsage(id).map(sessionUsageJSON);
    }
    return S.listAllSessionUsage().map(sessionUsageJSON);
  },

  usageSync(input: UsageSyncInput = {}): SessionUsageSyncResult {
    // Default sweep scans sessions linked to an open PR. `--session <id>` still targets any single
    // session for recompute.
    const rows: S.AgentSessionRow[] = input.sessionId
      ? [S.getAgentSession(input.sessionId)].filter(
          (row): row is S.AgentSessionRow => row !== null,
        )
      : S.listSessionsForUsageSweep();
    if (input.sessionId && rows.length === 0)
      throw new ServiceError(404, "Not Found");
    S.deleteZeroTokenSessionUsageRows(input.sessionId);

    // Runtime modules discover and correlate first, then the executor applies what they planned;
    // every filesystem read and cost calculation is done before the first transaction opens.
    const applied = applySessionUsageSync(planSessionUsageSync(rows, input));
    const results = rows.map((row) => applied.get(row.id)!);

    return {
      synced: results.filter((r) => r.status === "updated").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      missing: results.filter((r) => r.status === "missing").length,
      sessions: results,
    };
  },
};
