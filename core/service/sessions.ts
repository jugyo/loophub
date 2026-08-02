import { CODING_AGENTS, type CodingAgent, worktreeRoot } from "../config.ts";
import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import {
  RUNTIME_CLAUDE_CODE,
  RUNTIME_CODEX,
  RUNTIME_GROK,
  resolveWorktreeIdentity,
  sessionRuntime,
} from "../resume.ts";
import { isCodingAgent } from "../runtimes.ts";
import {
  type AgentCostSummaryWire,
  agentSessionJSON,
  sessionUsageJSON,
} from "../serialize.ts";
import { tokensPerFiveMinuteHistory } from "../session-rate-history.ts";
import {
  aggregateUsage,
  type ClaudeSubagentTranscript,
  type ClaudeSubagentTranscriptCandidate,
  calculateCostUsd,
  claudeContextWindowForModel,
  createClaudeTranscriptIndex,
  createCodexRolloutScan,
  findClaudeSubagentTranscriptCandidates,
  findClaudeTranscript,
  findCodexRollouts,
  findGrokSessionUpdates,
  type GrokTurnUsage,
  type ModelUsage,
  parseClaudeSubagentTranscript,
  parseClaudeUsageJsonl,
  readTranscriptSlice,
  type SubagentUsage,
  type UsageEntry,
} from "../session-usage.ts";
import {
  calculateTokensPerSecond,
  planGrokTurnRateSamples,
  totalTokens,
} from "../session-usage-rate.ts";
import * as S from "../store.ts";
import { legacyWorktreePath, worktreePath } from "../worktree-path.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

function worktreeCwdForPullSession(
  row: S.AgentSessionRow,
): { cwd: string; pullIssueId: number } | null {
  const target = S.listSessionLinkedTargets(row.id).find(
    (x) => x.kind === "pull",
  );
  if (!target) return null;

  try {
    const r = repoOr404(target.repo);
    const prRow = issueOr404(r, target.number, "pull");
    const pull = S.getPull(prRow.id)!;
    const identity = resolveWorktreeIdentity(pull.head_ref, prRow.number);
    const cwd =
      identity.scheme === "legacy-issue"
        ? legacyWorktreePath(worktreeRoot(), r.full_name, identity.number)
        : worktreePath(worktreeRoot(), r.full_name, identity.number);
    return { cwd, pullIssueId: prRow.id };
  } catch {
    return null;
  }
}

function codexUsageOwnerForPull(
  pullIssueId: number,
  fallbackSessionId: string,
): string {
  const primarySessionId = S.primaryDevSessionForPull(pullIssueId);
  const primary = primarySessionId ? S.getAgentSession(primarySessionId) : null;
  if (primary && sessionRuntime(primary) === RUNTIME_CODEX)
    return primarySessionId!;
  return (
    S.listSessionsForIssue(pullIssueId).find(
      (session) => sessionRuntime(session) === RUNTIME_CODEX,
    )?.id ?? fallbackSessionId
  );
}

function codexUsageTarget(row: S.AgentSessionRow): {
  cwd: string;
  ownerSessionId: string;
  pullIssueId: number;
} | null {
  if (sessionRuntime(row) !== RUNTIME_CODEX) return null;
  const base = worktreeCwdForPullSession(row);
  if (!base) return null;
  return {
    ...base,
    ownerSessionId: codexUsageOwnerForPull(base.pullIssueId, row.id),
  };
}

function grokUsageOwnerForPull(
  pullIssueId: number,
  fallbackSessionId: string,
): string {
  const primarySessionId = S.primaryDevSessionForPull(pullIssueId);
  const primary = primarySessionId ? S.getAgentSession(primarySessionId) : null;
  if (primary && sessionRuntime(primary) === RUNTIME_GROK)
    return primarySessionId!;
  return (
    S.listSessionsForIssue(pullIssueId).find(
      (session) => sessionRuntime(session) === RUNTIME_GROK,
    )?.id ?? fallbackSessionId
  );
}

function grokUsageTarget(row: S.AgentSessionRow): {
  cwd: string;
  ownerSessionId: string;
  pullIssueId: number;
} | null {
  if (sessionRuntime(row) !== RUNTIME_GROK) return null;
  const base = worktreeCwdForPullSession(row);
  if (!base) return null;
  return {
    ...base,
    ownerSessionId: grokUsageOwnerForPull(base.pullIssueId, row.id),
  };
}

function transcriptSetStats(
  transcript: { path: string; size: number; mtimeMs: number },
  subagents: ClaudeSubagentTranscriptCandidate[],
) {
  const files = [transcript, ...subagents];
  return {
    transcriptPath: [
      transcript.path,
      ...subagents.map(
        (x) => `subagent:${x.fallbackSourceId}:${x.size}:${x.mtimeMs}`,
      ),
    ].join("\n"),
    size: files.reduce((sum, x) => sum + x.size, 0),
    mtimeMs: Math.max(...files.map((x) => x.mtimeMs)),
  };
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

function secondsAgo(now: Date, seconds: number): string {
  return new Date(now.getTime() - seconds * 1000).toISOString();
}

interface UsageSamplePlan {
  samples: {
    totalTokens: number;
    tokenDelta?: number;
    observedAt: string;
  }[];
  pruneBefore: string;
}

function usageTotal(usage: ReadonlyArray<ModelUsage | S.SessionUsageRow>) {
  if (usage.length === 0) return null;
  return usage.reduce((sum, row) => sum + totalTokens(row), 0);
}

function planUsageSample(
  usage: ReadonlyArray<ModelUsage | S.SessionUsageRow>,
  now = new Date(),
): UsageSamplePlan | null {
  const total = usageTotal(usage);
  if (total == null) return null;
  return {
    samples: [
      {
        totalTokens: total,
        observedAt: now.toISOString(),
      },
    ],
    pruneBefore: secondsAgo(now, 600),
  };
}

// Grok has no mid-turn billed usage events. Precompute the sample pair before the DB phase so the
// transaction only persists it alongside the rewritten usage.
function planGrokUsageRateSamples(
  previousTotal: number | null,
  usage: ModelUsage[],
  turns: GrokTurnUsage[],
  now = new Date(),
): UsageSamplePlan | null {
  const newTotal = usageTotal(usage);
  if (newTotal == null) return null;
  const samples = planGrokTurnRateSamples({
    previousTotal: previousTotal ?? 0,
    newTotal,
    turns: turns.map((turn) => ({
      totalTokens: turn.totalTokens,
      apiDurationMs: turn.apiDurationMs,
    })),
    now,
  });
  return samples
    ? { samples, pruneBefore: secondsAgo(now, 600) }
    : planUsageSample(usage, now);
}

function saveUsageSamples(
  sessionId: string,
  plan: UsageSamplePlan | null,
): void {
  if (!plan) return;
  db.transaction(() => {
    for (const sample of plan.samples) {
      S.recordSessionUsageSample({
        sessionId,
        totalTokens: sample.totalTokens,
        observedAt: sample.observedAt,
        tokenDelta: sample.tokenDelta,
      });
    }
    S.pruneSessionUsageSamples(plan.pruneBefore);
  });
}

// Retention for the persisted live-rate history (#1123). Longer than the 600s sample TTL so a rate time
// series survives, bounded so the table cannot grow without limit.
const RATE_HISTORY_RETENTION_SECONDS = 7 * 24 * 60 * 60;

// The live aggregate tokens/sec used by the topbar's current five-minute bucket: in-progress dev and
// workflow-step sessions over the trailing 60s. The persisted history and current bucket share this
// definition.
function liveTokensPerSecond(now: Date): number | null {
  return calculateTokensPerSecond(
    S.listRecentInProgressSessionUsageSamples(secondsAgo(now, 60)),
    { now },
  );
}

function claudeSubagentUsage(
  subagents: ClaudeSubagentTranscript[],
): SubagentUsage[] {
  return subagents.flatMap((subagent) =>
    aggregateUsage(subagent.entries).map((usage) => ({
      source_id: subagent.sourceId,
      parent_source_id: subagent.parentSourceId,
      label: subagent.label,
      kind: subagent.kind,
      ...usage,
    })),
  );
}

function parseClaudeSubagentTranscripts(
  files: ClaudeSubagentTranscriptCandidate[],
): ClaudeSubagentTranscript[] {
  return files
    .map(parseClaudeSubagentTranscript)
    .filter((x): x is ClaudeSubagentTranscript => x != null);
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
      kind: "codex-child-rollout",
      ...usage,
    }));
  });
}

function saveSubagentUsage(sessionId: string, usage: SubagentUsage[]): void {
  for (const row of usage) S.upsertSessionSubagentUsage(sessionId, row);
}

function mergeModelUsage(
  current: ReadonlyArray<ModelUsage | S.SessionUsageRow>,
  additions: ModelUsage[],
): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const row of [...current, ...additions]) {
    const existing = byModel.get(row.model);
    const usage = existing
      ? {
          input_tokens: existing.input_tokens + row.input_tokens,
          cache_creation_input_tokens:
            existing.cache_creation_input_tokens +
            row.cache_creation_input_tokens,
          cache_read_input_tokens:
            existing.cache_read_input_tokens + row.cache_read_input_tokens,
          output_tokens: existing.output_tokens + row.output_tokens,
        }
      : {
          input_tokens: row.input_tokens,
          cache_creation_input_tokens: row.cache_creation_input_tokens,
          cache_read_input_tokens: row.cache_read_input_tokens,
          output_tokens: row.output_tokens,
        };
    const contexts = [
      existing?.context_usage_percent,
      row.context_usage_percent,
    ].filter((value): value is number => value != null);
    byModel.set(row.model, {
      model: row.model,
      ...usage,
      cost_usd: calculateCostUsd(row.model, usage),
      context_usage_percent: contexts.length > 0 ? Math.max(...contexts) : null,
    });
  }
  return [...byModel.values()];
}

function newUsageEntries(
  sessionId: string,
  parsed: UsageEntry[],
  checkStored: boolean,
): UsageEntry[] {
  const seen = new Set<string>();
  return parsed.filter((entry) => {
    if (seen.has(entry.message_id)) return false;
    seen.add(entry.message_id);
    return (
      !checkStored || !S.hasSessionUsageMessage(sessionId, entry.message_id)
    );
  });
}

function usageCursorEquals(
  expected: S.SessionUsageCursorRow | null,
  actual: S.SessionUsageCursorRow | null,
): boolean {
  return (
    expected?.session_id === actual?.session_id &&
    expected?.transcript_path === actual?.transcript_path &&
    expected?.cursor_offset === actual?.cursor_offset &&
    expected?.mtime_ms === actual?.mtime_ms
  );
}

function codexTargetKey(target: {
  ownerSessionId: string;
  pullIssueId: number;
}): string {
  return `${target.pullIssueId}\0${target.ownerSessionId}`;
}

function modelUsageEqualsStored(
  expected: ModelUsage[],
  actual: S.SessionUsageRow[],
): boolean {
  if (expected.length !== actual.length) return false;
  const actualByModel = new Map(actual.map((row) => [row.model, row]));
  return expected.every((usage) => {
    const row = actualByModel.get(usage.model);
    return (
      row?.input_tokens === usage.input_tokens &&
      row.cache_creation_input_tokens === usage.cache_creation_input_tokens &&
      row.cache_read_input_tokens === usage.cache_read_input_tokens &&
      row.output_tokens === usage.output_tokens &&
      row.cost_usd === usage.cost_usd &&
      row.context_usage_percent === (usage.context_usage_percent ?? null)
    );
  });
}

function needsClaudeContextBackfill(sessionId: string): boolean {
  const needsBackfill = (usage: {
    model: string;
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    context_usage_percent?: number | null;
  }) =>
    usage.context_usage_percent == null &&
    claudeContextWindowForModel(usage.model) != null &&
    usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens >
      0;
  return (
    S.listSessionUsage(sessionId).some(needsBackfill) ||
    S.listSessionSubagentUsage(sessionId).some(needsBackfill)
  );
}

function clearOtherCodexUsageForPull(
  pullIssueId: number,
  ownerSessionId: string,
): void {
  for (const session of S.listSessionsForIssue(pullIssueId)) {
    if (session.id === ownerSessionId) continue;
    if (sessionRuntime(session) !== RUNTIME_CODEX) continue;
    S.resetSessionUsage(session.id);
  }
}

function clearOtherGrokUsageForPull(
  pullIssueId: number,
  ownerSessionId: string,
): void {
  for (const session of S.listSessionsForIssue(pullIssueId)) {
    if (session.id === ownerSessionId) continue;
    if (sessionRuntime(session) !== RUNTIME_GROK) continue;
    S.resetSessionUsage(session.id);
  }
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
    return run?.parent_session_id
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
  }) {
    const { id, agent, session, name, runtime, kind } = input;
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
    const rate = liveTokensPerSecond(now);
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

    const out = CODING_AGENTS.map((agent) => byAgent.get(agent)!);
    out[0].tokens_per_second = rate;
    out[0].tokens_per_5m_history = tokensPerFiveMinuteHistory(
      S.listSessionRateHistory(secondsAgo(now, 3 * 60 * 60)),
      { now, liveTokensPerSecond: rate },
    );
    return out;
  },

  // Persist the current live aggregate tokens/sec (the source value the topbar converts to tokens/5m)
  // into the prune-resistant session_rate_history table (#1123), then trim rows past the retention
  // window. Called periodically by the worker's usage sweep. Skips writing when there is no active
  // rate so the table isn't padded with placeholder rows. Returns the recorded rate, or null when
  // nothing was written.
  recordLiveRateSample(now = new Date()): number | null {
    const rate = liveTokensPerSecond(now);
    if (rate == null) return null;
    db.transaction(() => {
      S.recordSessionRateHistory({
        tokensPerSecond: rate,
        observedAt: now.toISOString(),
      });
      S.pruneSessionRateHistory(
        secondsAgo(now, RATE_HISTORY_RETENTION_SECONDS),
      );
    });
    return rate;
  },

  usage(id?: string) {
    if (id) {
      if (!S.getAgentSession(id)) throw new ServiceError(404, "Not Found");
      return S.listSessionUsage(id).map(sessionUsageJSON);
    }
    return S.listAllSessionUsage().map(sessionUsageJSON);
  },

  usageSync(
    input: {
      sessionId?: string;
      full?: boolean;
      projectsDir?: string;
      codexSessionsDir?: string;
      grokSessionsDir?: string;
    } = {},
  ) {
    // Default sweep (#1119): scan only sessions linked to an open PR, so closed/merged PRs and
    // unlinked sessions no longer trigger transcript walks. `--session <id>` still targets any
    // single session for a forced recompute.
    const rows: S.AgentSessionRow[] = input.sessionId
      ? [S.getAgentSession(input.sessionId)].filter(
          (row): row is S.AgentSessionRow => row !== null,
        )
      : S.listSessionsLinkedToOpenPull();
    if (input.sessionId && rows.length === 0)
      throw new ServiceError(404, "Not Found");
    S.deleteZeroTokenSessionUsageRows(input.sessionId);

    const codexTargets = new Map<
      string,
      {
        cwd: string;
        ownerSessionId: string;
        pullIssueId: number;
      }
    >();
    const grokTargets = new Map<
      string,
      {
        cwd: string;
        ownerSessionId: string;
        pullIssueId: number;
      }
    >();
    for (const row of rows) {
      if (sessionRuntime(row) === RUNTIME_CODEX) {
        const target = codexUsageTarget(row);
        if (target) codexTargets.set(codexTargetKey(target), target);
        continue;
      }
      if (sessionRuntime(row) === RUNTIME_GROK) {
        const target = grokUsageTarget(row);
        if (target) grokTargets.set(codexTargetKey(target), target);
      }
    }
    const codexScan =
      codexTargets.size > 0
        ? createCodexRolloutScan(input.codexSessionsDir)
        : null;
    const claudeIndex = rows.some(
      (row) => sessionRuntime(row) === RUNTIME_CLAUDE_CODE,
    )
      ? createClaudeTranscriptIndex(
          input.projectsDir,
          rows
            .filter((row) => sessionRuntime(row) === RUNTIME_CLAUDE_CODE)
            .map((row) => row.external_session),
        )
      : null;

    const results = rows.map((row) => {
      if (sessionRuntime(row) === RUNTIME_CODEX) {
        const rowTarget = codexUsageTarget(row);
        const target = rowTarget
          ? codexTargets.get(codexTargetKey(rowTarget))
          : null;
        if (!target) {
          S.resetSessionUsage(row.id);
          return {
            session_id: row.id,
            status: "missing",
            messages: 0,
            models: [],
          };
        }

        if (row.id !== target.ownerSessionId) {
          S.resetSessionUsage(row.id);
          return {
            session_id: row.id,
            status: "skipped",
            messages: 0,
            models: [],
          };
        }

        // The rollout scan reads the filesystem, so it finishes before this session's DB phase.
        const rollouts = findCodexRollouts({
          cwd: target.cwd,
          sessionsDir: input.codexSessionsDir,
          scan: codexScan ?? undefined,
        });
        if (rollouts.length === 0) {
          S.resetSessionUsage(row.id);
          return {
            session_id: row.id,
            status: "missing",
            messages: 0,
            models: [],
          };
        }

        const transcriptPath = rollouts.map((x) => x.path).join("\n");
        const fresh = rollouts.flatMap((x) => x.entries);
        const aggregated = aggregateUsage(fresh);
        const subagentUsage = codexSubagentUsage(rollouts);
        const stored = S.listSessionUsage(row.id);
        const topLevelUnchanged =
          !input.full && modelUsageEqualsStored(aggregated, stored);
        const samplePlan = planUsageSample(
          topLevelUnchanged ? stored : aggregated,
        );
        return db.transaction(() => {
          if (!modelUsageEqualsStored(stored, S.listSessionUsage(row.id))) {
            throw new Error("Session usage changed during sync");
          }
          if (topLevelUnchanged) {
            S.deleteSessionSubagentUsageByKind(row.id, "codex-child-rollout");
            saveSubagentUsage(row.id, subagentUsage);
            clearOtherCodexUsageForPull(
              target.pullIssueId,
              target.ownerSessionId,
            );
            saveUsageSamples(row.id, samplePlan);
            return {
              session_id: row.id,
              status: "skipped",
              transcript_path: transcriptPath,
              messages: 0,
              models: S.listSessionUsage(row.id).map(sessionUsageJSON),
            };
          }

          S.resetSessionUsage(row.id);
          clearOtherCodexUsageForPull(
            target.pullIssueId,
            target.ownerSessionId,
          );
          for (const usage of aggregated) {
            S.upsertSessionUsage(row.id, usage);
          }
          saveSubagentUsage(row.id, subagentUsage);
          saveUsageSamples(row.id, samplePlan);

          return {
            session_id: row.id,
            status: fresh.length ? "updated" : "skipped",
            transcript_path: transcriptPath,
            messages: fresh.length,
            models: S.listSessionUsage(row.id).map(sessionUsageJSON),
          };
        });
      }

      if (sessionRuntime(row) === RUNTIME_GROK) {
        const rowTarget = grokUsageTarget(row);
        const target = rowTarget
          ? grokTargets.get(codexTargetKey(rowTarget))
          : null;
        if (!target) {
          S.resetSessionUsage(row.id);
          return {
            session_id: row.id,
            status: "missing",
            messages: 0,
            models: [],
          };
        }

        if (row.id !== target.ownerSessionId) {
          S.resetSessionUsage(row.id);
          return {
            session_id: row.id,
            status: "skipped",
            messages: 0,
            models: [],
          };
        }

        // The session scan reads the filesystem, so it finishes before this session's DB phase.
        const sessions = findGrokSessionUpdates({
          cwd: target.cwd,
          sessionsDir: input.grokSessionsDir,
        });
        if (sessions.length === 0) {
          S.resetSessionUsage(row.id);
          return {
            session_id: row.id,
            status: "missing",
            messages: 0,
            models: [],
          };
        }

        const transcriptPath = sessions.map((x) => x.path).join("\n");
        const fresh = sessions.flatMap((x) => x.entries);
        const turns = sessions.flatMap((x) => x.turns);
        const aggregated = aggregateUsage(fresh);
        const previousTotal = S.totalTokensForSession(row.id);
        const stored = S.listSessionUsage(row.id);
        const topLevelUnchanged =
          !input.full && modelUsageEqualsStored(aggregated, stored);
        const samplePlan = topLevelUnchanged
          ? planUsageSample(stored)
          : planGrokUsageRateSamples(previousTotal, aggregated, turns);
        return db.transaction(() => {
          if (!modelUsageEqualsStored(stored, S.listSessionUsage(row.id))) {
            throw new Error("Session usage changed during sync");
          }
          if (topLevelUnchanged) {
            clearOtherGrokUsageForPull(
              target.pullIssueId,
              target.ownerSessionId,
            );
            // Unchanged totals: keep a heartbeat sample (delta 0). Rate pairs are
            // only written when turn usage advances.
            saveUsageSamples(row.id, samplePlan);
            return {
              session_id: row.id,
              status: "skipped",
              transcript_path: transcriptPath,
              messages: 0,
              models: S.listSessionUsage(row.id).map(sessionUsageJSON),
            };
          }

          S.resetSessionUsage(row.id);
          clearOtherGrokUsageForPull(target.pullIssueId, target.ownerSessionId);
          for (const usage of aggregated) {
            S.upsertSessionUsage(row.id, usage);
          }
          saveUsageSamples(row.id, samplePlan);

          return {
            session_id: row.id,
            status: fresh.length ? "updated" : "skipped",
            transcript_path: transcriptPath,
            messages: fresh.length,
            models: S.listSessionUsage(row.id).map(sessionUsageJSON),
          };
        });
      }

      const transcript = findClaudeTranscript(
        row.external_session,
        input.projectsDir,
        claudeIndex ?? undefined,
      );
      if (!transcript) {
        return {
          session_id: row.id,
          status: "missing",
          messages: 0,
          models: [],
        };
      }

      const subagentCandidates =
        findClaudeSubagentTranscriptCandidates(transcript);
      const transcriptStats = transcriptSetStats(
        transcript,
        subagentCandidates,
      );
      const cursor = S.getSessionUsageCursor(row.id);
      const sameFile =
        cursor?.transcript_path === transcriptStats.transcriptPath;
      const needsContextBackfill = needsClaudeContextBackfill(row.id);
      const unchanged =
        !input.full &&
        !needsContextBackfill &&
        sameFile &&
        cursor.cursor_offset === transcriptStats.size &&
        cursor.mtime_ms === transcriptStats.mtimeMs;
      if (unchanged) {
        const stored = S.listSessionUsage(row.id);
        const samplePlan = planUsageSample(stored);
        saveUsageSamples(row.id, samplePlan);
        return {
          session_id: row.id,
          status: "skipped",
          transcript_path: transcriptStats.transcriptPath,
          messages: 0,
          models: S.listSessionUsage(row.id).map(sessionUsageJSON),
        };
      }

      const subagents = parseClaudeSubagentTranscripts(subagentCandidates);
      const canContinue =
        !input.full &&
        !needsContextBackfill &&
        subagentCandidates.length === 0 &&
        sameFile &&
        cursor &&
        cursor.cursor_offset < transcript.size;
      const offset = canContinue ? cursor.cursor_offset : 0;

      // Every transcript read happens here, before the DB phase: the usage rows, the message dedupe
      // table and the cursor that says how far the transcript was consumed must agree, so a partial
      // write would make the next sweep resume from a position it never actually reached.
      const parsed = canContinue
        ? parseClaudeUsageJsonl(readTranscriptSlice(transcript.path, offset))
        : [
            ...parseClaudeUsageJsonl(readTranscriptSlice(transcript.path, 0)),
            ...subagents.flatMap((subagent) => subagent.entries),
          ];
      const fresh = newUsageEntries(row.id, parsed, Boolean(canContinue));
      const aggregated = aggregateUsage(fresh);
      const finalUsage = canContinue
        ? mergeModelUsage(S.listSessionUsage(row.id), aggregated)
        : aggregated;
      const subagentUsage = claudeSubagentUsage(subagents);
      const samplePlan = planUsageSample(finalUsage);
      return db.transaction(() => {
        if (
          canContinue &&
          !usageCursorEquals(cursor, S.getSessionUsageCursor(row.id))
        ) {
          throw new Error("Session usage changed during sync");
        }
        if (!canContinue) S.resetSessionUsage(row.id);
        for (const entry of fresh) {
          if (!S.insertSessionUsageMessage(row.id, entry.message_id)) {
            throw new Error("Session usage changed during sync");
          }
        }

        for (const usage of aggregated) {
          S.upsertSessionUsage(row.id, usage);
        }
        if (!canContinue) saveSubagentUsage(row.id, subagentUsage);
        for (const usage of finalUsage) {
          S.rewriteSessionUsageCost(row.id, usage.model, usage.cost_usd);
        }
        saveUsageSamples(row.id, samplePlan);

        S.upsertSessionUsageCursor({
          sessionId: row.id,
          transcriptPath: transcriptStats.transcriptPath,
          cursorOffset: transcriptStats.size,
          mtimeMs: transcriptStats.mtimeMs,
        });

        return {
          session_id: row.id,
          status: fresh.length ? "updated" : "skipped",
          transcript_path: transcriptStats.transcriptPath,
          messages: fresh.length,
          models: S.listSessionUsage(row.id).map(sessionUsageJSON),
        };
      });
    });

    return {
      synced: results.filter((r) => r.status === "updated").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      missing: results.filter((r) => r.status === "missing").length,
      sessions: results,
    };
  },
};
