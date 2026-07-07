// Sidebar usage summary aggregation (#839). Derives per-agent (Claude Code / Codex) "current
// session" and "current week" totals from the same `sessions/list` payload the Stats/Sessions page
// consumes, so the sidebar numbers reconcile with the saved session usage rather than a separate
// count. Pure and time-injected (`now`) so it stays deterministic and unit-testable.

import type { AgentSession, SessionUsage } from "@/api/types";
import { totalTokens, usageTotal } from "@/lib/session-usage";

export type UsageAgent = "claude" | "codex";

export interface AgentUsageBucket {
  tokens: number;
  // null when the bucket has usage but at least one model's cost is unknown (mirrors usageCost),
  // or when the bucket is empty — callers render "n/a" either way.
  cost: number | null;
  hasUsage: boolean;
}

export interface AgentUsageSummary {
  agent: UsageAgent;
  currentSession: AgentUsageBucket;
  currentWeek: AgentUsageBucket;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_BUCKET: AgentUsageBucket = {
  tokens: 0,
  cost: null,
  hasUsage: false,
};

// Codex rollout usage rows carry OpenAI model ids (`gpt-*`) or the `codex` fallback
// (core/session-usage.ts); everything else (opus/sonnet/haiku/fable/mythos/claude-*) is Claude
// Code. Classifying per usage row keeps a session that somehow mixed both correctly split.
export function agentForModel(model: string): UsageAgent {
  const m = model.toLowerCase();
  return m.startsWith("gpt") || m.includes("codex") ? "codex" : "claude";
}

function bucketFromRows(rows: SessionUsage[]): AgentUsageBucket {
  if (rows.length === 0) return EMPTY_BUCKET;
  const tokens = totalTokens(usageTotal(rows));
  const cost = rows.some((r) => r.cost_usd === null)
    ? null
    : rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  return { tokens, cost, hasUsage: true };
}

function agentRows(session: AgentSession, agent: UsageAgent): SessionUsage[] {
  return (session.usage ?? []).filter((r) => agentForModel(r.model) === agent);
}

function summarizeAgent(
  sessions: AgentSession[],
  agent: UsageAgent,
  nowMs: number,
): AgentUsageSummary {
  // Current session: the most recently updated session that has usage for this agent.
  let latest: AgentSession | null = null;
  const weekRows: SessionUsage[] = [];
  for (const s of sessions) {
    const rows = agentRows(s, agent);
    if (rows.length === 0) continue;
    if (!latest || s.updated_at > latest.updated_at) latest = s;
    const updatedMs = Date.parse(s.updated_at);
    // Age within [0, 7d]. The lower bound guards a future-dated updated_at (cross-machine clock
    // skew, or a bad row): without it a negative age still passes `<= WEEK_MS` and gets counted.
    const ageMs = nowMs - updatedMs;
    if (Number.isFinite(updatedMs) && ageMs >= 0 && ageMs <= WEEK_MS) {
      weekRows.push(...rows);
    }
  }
  return {
    agent,
    currentSession: latest
      ? bucketFromRows(agentRows(latest, agent))
      : EMPTY_BUCKET,
    currentWeek: bucketFromRows(weekRows),
  };
}

// Always returns both agents (claude first) so the sidebar renders a stable two-row layout with
// n/a where an agent has no data — never a jumping list.
export function summarizeSidebarUsage(
  sessions: AgentSession[] | undefined,
  nowMs: number,
): AgentUsageSummary[] {
  const list = sessions ?? [];
  return [
    summarizeAgent(list, "claude", nowMs),
    summarizeAgent(list, "codex", nowMs),
  ];
}
