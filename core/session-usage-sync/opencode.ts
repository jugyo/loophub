import { RUNTIME_OPENCODE, sessionRuntime } from "../session-runtime.ts";
import {
  aggregateUsage,
  calculateCostUsd,
  findOpencodeSessions,
  type OpencodeSessionCandidate,
  type SubagentUsage,
} from "../session-usage.ts";
import * as S from "../store.ts";
import {
  missingUsagePlan,
  modelUsageEqualsStored,
  type SessionUsagePlan,
  type SessionUsageSyncModule,
  type SessionUsageSyncOptions,
  usageSyncStatus,
} from "./plan.ts";
import {
  supersededWorktreeSessions,
  type WorktreeUsageTarget,
  worktreeUsageTarget,
  worktreeUsageTargetKey,
} from "./targets.ts";

const CHILD_SESSION_KIND = "opencode-child-session";

/**
 * OpenCode usage sync. OpenCode does not take a LoopHub session id; it records
 * sessions in ~/.local/share/opencode/opencode.db keyed by worktree directory.
 * Every session under a PR worktree aggregates onto that PR's owner session, and
 * peer sessions sharing the worktree are cleared to avoid double counting.
 *
 * Cost uses core/pricing.ts for known model ids. OpenCode can switch among many
 * providers, so unresolved models keep token totals with cost_usd=null rather
 * than inventing a rate.
 */
export const opencodeUsageSync: SessionUsageSyncModule = {
  owns: (row) => sessionRuntime(row) === RUNTIME_OPENCODE,

  plan(rows, options) {
    const targetBySession = new Map<string, WorktreeUsageTarget>();
    const targets = new Map<string, WorktreeUsageTarget>();
    for (const row of rows) {
      const target = worktreeUsageTarget(row, RUNTIME_OPENCODE);
      if (!target) continue;
      const key = worktreeUsageTargetKey(target);
      const shared = targets.get(key) ?? target;
      targets.set(key, shared);
      targetBySession.set(row.id, shared);
    }
    // Sessions sharing a worktree read the same OpenCode DB query once.
    const sessionsByCwd = new Map<string, OpencodeSessionCandidate[]>();
    const sessionsFor = (cwd: string) => {
      const cached = sessionsByCwd.get(cwd);
      if (cached) return cached;
      const found = findOpencodeSessions({
        cwd,
        dbPath: options.opencodeDbPath,
      });
      sessionsByCwd.set(cwd, found);
      return found;
    };

    return rows.map((row) => ({
      key: `opencode:${row.id}`,
      plans: [
        planOpencodeSession(
          row,
          options,
          targetBySession.get(row.id),
          sessionsFor,
        ),
      ],
    }));
  },
};

function planOpencodeSession(
  row: S.AgentSessionRow,
  options: SessionUsageSyncOptions,
  target: WorktreeUsageTarget | undefined,
  sessionsFor: (cwd: string) => OpencodeSessionCandidate[],
): SessionUsagePlan {
  if (!target) return missingUsagePlan(row.id, true);

  if (row.id !== target.ownerSessionId) {
    return {
      sessionId: row.id,
      resetUsage: true,
      report: { status: usageSyncStatus(0), messages: 0, models: "none" },
    };
  }

  const opencodeSessions = sessionsFor(target.cwd);
  if (opencodeSessions.length === 0) return missingUsagePlan(row.id, true);

  const transcriptPath = opencodeSessions.map((x) => x.path).join("\n");
  const fresh = opencodeSessions.flatMap((x) => x.entries);
  const aggregated = aggregateUsage(fresh);
  const subagents = opencodeChildSessionUsage(opencodeSessions);
  const stored = S.listSessionUsage(row.id);
  const clearUsageFor = supersededWorktreeSessions(target, RUNTIME_OPENCODE);
  const topLevelUnchanged =
    !options.full && modelUsageEqualsStored(aggregated, stored);

  if (topLevelUnchanged) {
    return {
      sessionId: row.id,
      expect: { usage: stored },
      clearUsageFor,
      subagents: { deleteKind: CHILD_SESSION_KIND, rows: subagents },
      report: {
        status: usageSyncStatus(0),
        transcriptPath,
        messages: 0,
        models: "stored",
      },
    };
  }

  return {
    sessionId: row.id,
    expect: { usage: stored },
    resetUsage: true,
    clearUsageFor,
    usage: aggregated,
    // Rewrite costs so known models get pricing.ts rates and unknown models stay null.
    usageCosts: aggregated.map((usage) => ({
      model: usage.model,
      costUsd: calculateCostUsd(usage.model, usage),
    })),
    subagents: { rows: subagents },
    report: {
      status: usageSyncStatus(fresh.length),
      transcriptPath,
      messages: fresh.length,
      models: "stored",
    },
  };
}

function opencodeChildSessionUsage(
  sessions: OpencodeSessionCandidate[],
): SubagentUsage[] {
  return sessions.flatMap((session) => {
    if (!session.parentSessionId) return [];
    return aggregateUsage(session.entries).map((usage) => ({
      source_id: session.sessionId,
      parent_source_id: session.parentSessionId,
      label: `OpenCode session ${session.sessionId}`,
      kind: CHILD_SESSION_KIND,
      ...usage,
    }));
  });
}
