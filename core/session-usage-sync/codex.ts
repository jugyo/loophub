import { RUNTIME_CODEX, sessionRuntime } from "../session-runtime.ts";
import {
  aggregateUsage,
  type CodexRolloutCandidate,
  createCodexRolloutScan,
  findCodexRollouts,
  type SubagentUsage,
  type UsageEntry,
} from "../session-usage.ts";
import * as S from "../store.ts";
import {
  missingUsagePlan,
  modelUsageEqualsStored,
  planUsageSample,
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

const CHILD_ROLLOUT_KIND = "codex-child-rollout";

/**
 * Codex usage sync. Codex rollouts are correlated by the worktree cwd they ran in, not by session
 * id, so every rollout under a PR's worktree aggregates onto that PR's owner session and the peer
 * sessions sharing the worktree are cleared to avoid double counting.
 */
export const codexUsageSync: SessionUsageSyncModule = {
  owns: (row) => sessionRuntime(row) === RUNTIME_CODEX,

  plan(rows, options) {
    const targets = new Map<string, WorktreeUsageTarget>();
    const targetBySession = new Map<string, WorktreeUsageTarget>();
    for (const row of rows) {
      const target = worktreeUsageTarget(row, RUNTIME_CODEX);
      if (!target) continue;
      const key = worktreeUsageTargetKey(target);
      const shared = targets.get(key) ?? target;
      targets.set(key, shared);
      targetBySession.set(row.id, shared);
    }
    // One scan for the sweep, then one parse per worktree: sessions sharing a cwd reuse the same
    // rollout list instead of walking the sessions directory again.
    const scan =
      targets.size > 0
        ? createCodexRolloutScan(options.codexSessionsDir)
        : null;
    const rolloutsByCwd = new Map<string, CodexRolloutCandidate[]>();
    const rolloutsFor = (cwd: string) => {
      const cached = rolloutsByCwd.get(cwd);
      if (cached) return cached;
      const found = findCodexRollouts({
        cwd,
        sessionsDir: options.codexSessionsDir,
        scan: scan ?? undefined,
      });
      rolloutsByCwd.set(cwd, found);
      return found;
    };

    return rows.map((row) => ({
      key: `codex:${row.id}`,
      plans: [
        planCodexSession(
          row,
          options,
          targetBySession.get(row.id),
          rolloutsFor,
        ),
      ],
    }));
  },
};

function planCodexSession(
  row: S.AgentSessionRow,
  options: SessionUsageSyncOptions,
  target: WorktreeUsageTarget | undefined,
  rolloutsFor: (cwd: string) => CodexRolloutCandidate[],
): SessionUsagePlan {
  if (!target) return missingUsagePlan(row.id, true);

  // Only the owner carries the worktree total; a peer's own rows would double count it.
  if (row.id !== target.ownerSessionId) {
    return {
      sessionId: row.id,
      resetUsage: true,
      report: { status: usageSyncStatus(0), messages: 0, models: "none" },
    };
  }

  const rollouts = rolloutsFor(target.cwd);
  if (rollouts.length === 0) return missingUsagePlan(row.id, true);

  const transcriptPath = rollouts.map((x) => x.path).join("\n");
  const fresh = rollouts.flatMap((x) => x.entries);
  const aggregated = aggregateUsage(fresh);
  const subagents = codexSubagentUsage(rollouts);
  const stored = S.listSessionUsage(row.id);
  const clearUsageFor = supersededWorktreeSessions(target, RUNTIME_CODEX);
  const topLevelUnchanged =
    !options.full && modelUsageEqualsStored(aggregated, stored);

  if (topLevelUnchanged) {
    return {
      sessionId: row.id,
      expect: { usage: stored },
      clearUsageFor,
      // Child rollouts come and go across sweeps, so their rows are replaced even when the totals
      // did not move.
      subagents: { deleteKind: CHILD_ROLLOUT_KIND, rows: subagents },
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
    subagents: { rows: subagents },
    samples: planUsageSample(aggregated),
    report: {
      status: usageSyncStatus(fresh.length),
      transcriptPath,
      messages: fresh.length,
      models: "stored",
    },
  };
}

function codexSubagentUsage(
  rollouts: {
    path: string;
    threadId: string | null;
    parentThreadId: string | null;
    entries: UsageEntry[];
  }[],
): SubagentUsage[] {
  return rollouts.flatMap((rollout) => {
    if (!rollout.parentThreadId) return [];
    const fallbackId = rollout.path.split(/[\\/]/).pop() ?? "unknown-rollout";
    const sourceId = rollout.threadId ?? `rollout:${fallbackId}`;
    return aggregateUsage(rollout.entries).map((usage) => ({
      source_id: sourceId,
      parent_source_id: rollout.parentThreadId,
      label: rollout.threadId ? `Codex thread ${rollout.threadId}` : null,
      kind: CHILD_ROLLOUT_KIND,
      ...usage,
    }));
  });
}
