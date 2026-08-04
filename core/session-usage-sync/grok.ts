import { RUNTIME_GROK, sessionRuntime } from "../session-runtime.ts";
import {
  aggregateUsage,
  calculateCostUsd,
  findGrokSessionUpdates,
  type GrokSessionCandidate,
  type GrokTurnUsage,
  type ModelUsage,
} from "../session-usage.ts";
import { planGrokTurnRateSamples } from "../session-usage-rate.ts";
import * as S from "../store.ts";
import {
  missingUsagePlan,
  modelUsageEqualsStored,
  planUsageSample,
  type SessionUsagePlan,
  type SessionUsageSyncModule,
  type SessionUsageSyncOptions,
  type UsageSamplePlan,
  usageSamplePruneBefore,
  usageSyncStatus,
  usageTotals,
} from "./plan.ts";
import {
  supersededWorktreeSessions,
  type WorktreeUsageTarget,
  worktreeUsageTarget,
  worktreeUsageTargetKey,
} from "./targets.ts";

/**
 * Grok usage sync. Like Codex, Grok correlates by worktree cwd and aggregates onto the PR's owner
 * session. Unlike Codex it reports per-turn API durations, which the plan turns into the rate sample
 * pair the live tokens/sec reading needs.
 */
export const grokUsageSync: SessionUsageSyncModule = {
  owns: (row) => sessionRuntime(row) === RUNTIME_GROK,

  plan(rows, options) {
    const targetBySession = new Map<string, WorktreeUsageTarget>();
    const targets = new Map<string, WorktreeUsageTarget>();
    for (const row of rows) {
      const target = worktreeUsageTarget(row, RUNTIME_GROK);
      if (!target) continue;
      const key = worktreeUsageTargetKey(target);
      const shared = targets.get(key) ?? target;
      targets.set(key, shared);
      targetBySession.set(row.id, shared);
    }
    // Sessions sharing a worktree read the same session directory once.
    const sessionsByCwd = new Map<string, GrokSessionCandidate[]>();
    const sessionsFor = (cwd: string) => {
      const cached = sessionsByCwd.get(cwd);
      if (cached) return cached;
      const found = findGrokSessionUpdates({
        cwd,
        sessionsDir: options.grokSessionsDir,
      });
      sessionsByCwd.set(cwd, found);
      return found;
    };

    return rows.map((row) => ({
      key: `grok:${row.id}`,
      plans: [
        planGrokSession(row, options, targetBySession.get(row.id), sessionsFor),
      ],
    }));
  },
};

function planGrokSession(
  row: S.AgentSessionRow,
  options: SessionUsageSyncOptions,
  target: WorktreeUsageTarget | undefined,
  sessionsFor: (cwd: string) => GrokSessionCandidate[],
): SessionUsagePlan {
  if (!target) return missingUsagePlan(row.id, true);

  if (row.id !== target.ownerSessionId) {
    return {
      sessionId: row.id,
      resetUsage: true,
      report: { status: usageSyncStatus(0), messages: 0, models: "none" },
    };
  }

  const grokSessions = sessionsFor(target.cwd);
  if (grokSessions.length === 0) return missingUsagePlan(row.id, true);

  const transcriptPath = grokSessions.map((x) => x.path).join("\n");
  const fresh = grokSessions.flatMap((x) => x.entries);
  const turns = grokSessions.flatMap((x) => x.turns);
  const aggregated = aggregateUsage(fresh);
  const stored = S.listSessionUsage(row.id);
  const clearUsageFor = supersededWorktreeSessions(target, RUNTIME_GROK);
  const topLevelUnchanged =
    !options.full && modelUsageEqualsStored(aggregated, stored);

  if (topLevelUnchanged) {
    return {
      sessionId: row.id,
      expect: { usage: stored },
      clearUsageFor,
      // Unchanged totals: keep a heartbeat sample (delta 0). Rate pairs are only written when turn
      // usage advances.
      samples: planUsageSample(stored),
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
    // Grok reports one total per model, so the cost is rewritten rather than accumulated.
    usageCosts: aggregated.map((usage) => ({
      model: usage.model,
      costUsd: calculateCostUsd(usage.model, usage),
    })),
    samples: planGrokUsageRateSamples(
      S.tokenTotalsForSession(row.id),
      aggregated,
      turns,
    ),
    report: {
      status: usageSyncStatus(fresh.length),
      transcriptPath,
      messages: fresh.length,
      models: "stored",
    },
  };
}

// Grok has no mid-turn billed usage events. Reconstruct the sample pair from the turn durations so
// the live rate reading has something to interpolate, falling back to a single total sample.
function planGrokUsageRateSamples(
  previousTotals: ReturnType<typeof S.tokenTotalsForSession>,
  usage: ModelUsage[],
  turns: GrokTurnUsage[],
  now = new Date(),
): UsageSamplePlan | null {
  const newTotals = usageTotals(usage);
  if (newTotals == null) return null;
  const samples = planGrokTurnRateSamples({
    previousTotal: previousTotals?.totalTokens ?? 0,
    newTotal: newTotals.totalTokens,
    previousCacheRead: previousTotals?.cacheReadTokens ?? 0,
    newCacheRead: newTotals.cacheReadTokens,
    turns: turns.map((turn) => ({
      totalTokens: turn.totalTokens,
      cacheReadTokens: turn.usage.cache_read_input_tokens,
      apiDurationMs: turn.apiDurationMs,
    })),
    now,
  });
  return samples
    ? { samples, pruneBefore: usageSamplePruneBefore(now) }
    : planUsageSample(usage, now);
}
