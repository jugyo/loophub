import { CODING_AGENTS, type CodingAgent } from "../config.ts";
import type { AgentCostSummaryWire } from "../serialize.ts";
import { calculateTokensPerSecond } from "../session-usage-rate.ts";
import type {
  ClaudeSubagentTranscript,
  ClaudeSubagentTranscriptCandidate,
  ModelUsage,
  UsageEntry,
} from "./shared.ts";
import {
  actorFor,
  agentSessionJSON,
  aggregateUsage,
  calculateCostUsd,
  claudeContextWindowForModel,
  createClaudeTranscriptIndex,
  createCodexRolloutScan,
  ensureWritable,
  findClaudeSubagentTranscriptCandidates,
  findClaudeTranscript,
  findCodexRollouts,
  issueOr404,
  legacyWorktreePath,
  parseClaudeSubagentTranscript,
  parseClaudeUsageJsonl,
  RUNTIME_CODEX,
  readTranscriptSlice,
  relatedSessionsJSON,
  repoOr404,
  resolveWorktreeIdentity,
  S,
  ServiceError,
  sessionRuntime,
  sessionUsageJSON,
  worktreePath,
  worktreeRoot,
} from "./shared.ts";

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
    const ownerSessionId = codexUsageOwnerForPull(prRow.id, row.id);
    return { cwd, ownerSessionId, pullIssueId: prRow.id };
  } catch {
    return null;
  }
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

function isCodingAgent(value: string | null | undefined): value is CodingAgent {
  return value === "claude-code" || value === "codex";
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

function recordUsageSample(sessionId: string): void {
  const totalTokens = S.totalTokensForSession(sessionId);
  if (totalTokens == null) return;
  S.recordSessionUsageSample({ sessionId, totalTokens });
  S.pruneSessionUsageSamples(secondsAgo(new Date(), 600));
}

function saveClaudeSubagentUsage(
  sessionId: string,
  subagents: ClaudeSubagentTranscript[],
): void {
  for (const subagent of subagents) {
    for (const usage of aggregateUsage(subagent.entries)) {
      S.upsertSessionSubagentUsage(sessionId, {
        source_id: subagent.sourceId,
        parent_source_id: subagent.parentSourceId,
        label: subagent.label,
        kind: subagent.kind,
        ...usage,
      });
    }
  }
}

function parseClaudeSubagentTranscripts(
  files: ClaudeSubagentTranscriptCandidate[],
): ClaudeSubagentTranscript[] {
  return files
    .map(parseClaudeSubagentTranscript)
    .filter((x): x is ClaudeSubagentTranscript => x != null);
}

function saveCodexSubagentUsage(
  sessionId: string,
  rollouts: {
    path: string;
    threadId: string | null;
    parentThreadId: string | null;
    entries: UsageEntry[];
  }[],
): void {
  S.deleteSessionSubagentUsageByKind(sessionId, "codex-child-rollout");
  for (const rollout of rollouts) {
    if (!rollout.parentThreadId) continue;
    const fallbackId = rollout.path.split(/[\\/]/).pop() ?? "unknown-rollout";
    const sourceId = rollout.threadId ?? `rollout:${fallbackId}`;
    for (const usage of aggregateUsage(rollout.entries)) {
      S.upsertSessionSubagentUsage(sessionId, {
        source_id: sourceId,
        parent_source_id: rollout.parentThreadId,
        label: rollout.threadId ? `Codex thread ${rollout.threadId}` : null,
        kind: "codex-child-rollout",
        ...usage,
      });
    }
  }
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

export const sessions = {
  // Thin pass-throughs so callers outside core/ (lh-worker's usage sweep) don't reach into
  // core/store directly.
  authorFromSession(sessionId: string | null | undefined): string | null {
    return S.authorFromSession(sessionId);
  },

  linkedTargets(sessionId: string): S.SessionLinkedTargetRow[] {
    return S.listSessionLinkedTargets(sessionId);
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
    S.linkSession(sessionId, row.id);
    // `agent_session.*` namespace (matches register's agent_session.registered/updated) so the
    // web event-key router (web/src/lib/event-keys.ts startsWith "agent_session.") invalidates the
    // agent-sessions queries on a link too.
    S.emitEvent(r.id, "agent_session.linked", actorFor(sessionId), {
      session_id: sessionId,
      [targetKind === "pull" ? "pr" : "issue"]: row.number,
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
    const rate = calculateTokensPerSecond(
      S.listRecentInProgressSessionUsageSamples(secondsAgo(now, 60)),
      { now },
    );
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
    if (rate != null) out[0].tokens_per_second = rate;
    return out;
  },

  get(id: string) {
    const row = S.getAgentSession(id);
    if (!row) throw new ServiceError(404, "Not Found");
    return agentSessionJSON(row);
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
    } = {},
  ) {
    const rows: S.AgentSessionRow[] = input.sessionId
      ? [S.getAgentSession(input.sessionId)].filter(
          (row): row is S.AgentSessionRow => row !== null,
        )
      : S.listAgentSessions();
    if (input.sessionId && rows.length === 0)
      throw new ServiceError(404, "Not Found");

    const codexTargets = new Map<
      string,
      {
        cwd: string;
        ownerSessionId: string;
        pullIssueId: number;
      }
    >();
    for (const row of rows) {
      if (sessionRuntime(row) !== RUNTIME_CODEX) continue;
      const target = codexUsageTarget(row);
      if (target) codexTargets.set(codexTargetKey(target), target);
    }
    const codexScan =
      codexTargets.size > 0
        ? createCodexRolloutScan(input.codexSessionsDir)
        : null;
    const claudeIndex = rows.some(
      (row) => sessionRuntime(row) !== RUNTIME_CODEX,
    )
      ? createClaudeTranscriptIndex(
          input.projectsDir,
          rows
            .filter((row) => sessionRuntime(row) !== RUNTIME_CODEX)
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
        const topLevelUnchanged =
          !input.full &&
          modelUsageEqualsStored(aggregated, S.listSessionUsage(row.id));
        if (topLevelUnchanged) {
          saveCodexSubagentUsage(row.id, rollouts);
          clearOtherCodexUsageForPull(
            target.pullIssueId,
            target.ownerSessionId,
          );
          recordUsageSample(row.id);
          return {
            session_id: row.id,
            status: "skipped",
            transcript_path: transcriptPath,
            messages: 0,
            models: S.listSessionUsage(row.id).map(sessionUsageJSON),
          };
        }

        S.resetSessionUsage(row.id);
        clearOtherCodexUsageForPull(target.pullIssueId, target.ownerSessionId);
        for (const usage of aggregated) {
          S.upsertSessionUsage(row.id, usage);
        }
        saveCodexSubagentUsage(row.id, rollouts);
        for (const usage of S.listSessionUsage(row.id)) {
          S.rewriteSessionUsageCost(
            row.id,
            usage.model,
            calculateCostUsd(usage.model, usage),
          );
        }
        recordUsageSample(row.id);

        return {
          session_id: row.id,
          status: fresh.length ? "updated" : "skipped",
          transcript_path: transcriptPath,
          messages: fresh.length,
          models: S.listSessionUsage(row.id).map(sessionUsageJSON),
        };
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
        recordUsageSample(row.id);
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

      const parsed = canContinue
        ? parseClaudeUsageJsonl(readTranscriptSlice(transcript.path, offset))
        : [
            ...parseClaudeUsageJsonl(readTranscriptSlice(transcript.path, 0)),
            ...subagents.flatMap((subagent) => subagent.entries),
          ];
      if (!canContinue) S.resetSessionUsage(row.id);
      const fresh: UsageEntry[] = [];
      for (const entry of parsed) {
        if (S.insertSessionUsageMessage(row.id, entry.message_id))
          fresh.push(entry);
      }

      for (const usage of aggregateUsage(fresh)) {
        S.upsertSessionUsage(row.id, usage);
      }
      if (!canContinue) saveClaudeSubagentUsage(row.id, subagents);
      for (const usage of S.listSessionUsage(row.id)) {
        S.rewriteSessionUsageCost(
          row.id,
          usage.model,
          calculateCostUsd(usage.model, usage),
        );
      }
      recordUsageSample(row.id);

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

    return {
      synced: results.filter((r) => r.status === "updated").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      missing: results.filter((r) => r.status === "missing").length,
      sessions: results,
    };
  },

  // The related-sessions list for a PR or issue (#298), standalone — same payload pullJSON/issueJSON
  // embed as `related_sessions`, exposed directly for clients that want it without the full detail.
  listFor(name: string, input: { issue?: number; pr?: number }): any[] {
    const r = repoOr404(name);
    const { issue, pr } = input;
    if ((issue == null) === (pr == null))
      throw new ServiceError(422, "exactly one of issue or pr is required");
    if (issue != null)
      return relatedSessionsJSON(issueOr404(r, issue, "issue"));
    const row = issueOr404(r, pr as number, "pull");
    return relatedSessionsJSON(row, {
      primarySessionId: S.primaryDevSessionForPull(row.id),
    });
  },
};
