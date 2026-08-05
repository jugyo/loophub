import { RUNTIME_CLAUDE_CODE, sessionRuntime } from "../session-runtime.ts";
import {
  aggregateUsage,
  type ClaudeSubagentTranscript,
  type ClaudeSubagentTranscriptCandidate,
  type ClaudeTranscriptIndex,
  calculateCostUsd,
  claudeContextWindowForModel,
  createClaudeTranscriptIndex,
  findClaudeSubagentTranscriptCandidates,
  findClaudeTranscript,
  type ModelUsage,
  parseClaudeSubagentTranscript,
  parseClaudeUsageJsonl,
  readTranscriptSlice,
  type SubagentUsage,
  type UsageEntry,
} from "../session-usage.ts";
import * as S from "../store.ts";
import {
  missingUsagePlan,
  type SessionUsagePlan,
  type SessionUsageSyncModule,
  type SessionUsageSyncOptions,
  usageSyncStatus,
} from "./plan.ts";

/**
 * Claude Code usage sync. Transcripts are keyed by the caller-supplied session id, so a session is
 * its own target: one transcript plus the sidechain files it spawned, consumed incrementally from
 * the offset the previous sweep recorded.
 *
 * This is also the fallback module. Sessions registered before the runtime column existed carry no
 * runtime, and their launcher always ran Claude Code, so anything the other modules do not claim
 * syncs here.
 */
export const claudeUsageSync: SessionUsageSyncModule = {
  owns: () => true,

  plan(rows, options) {
    // One index for the whole sweep: it direct-stats the wanted transcript filenames in each project
    // directory, so a directory is walked once instead of once per session.
    const claudeRows = rows.filter(
      (row) => sessionRuntime(row) === RUNTIME_CLAUDE_CODE,
    );
    const index =
      claudeRows.length > 0
        ? createClaudeTranscriptIndex(
            options.projectsDir,
            claudeRows.map((row) => row.external_session),
          )
        : null;
    return rows.map((row) => ({
      key: `claude:${row.id}`,
      plans: [planClaudeSession(row, options, index)],
    }));
  },
};

function planClaudeSession(
  row: S.AgentSessionRow,
  options: SessionUsageSyncOptions,
  index: ClaudeTranscriptIndex | null,
): SessionUsagePlan {
  const transcript = findClaudeTranscript(
    row.external_session,
    options.projectsDir,
    index ?? undefined,
  );
  // A transcript that is not on disk right now says nothing about the usage already imported from
  // it, so previously recorded totals stay.
  if (!transcript) return missingUsagePlan(row.id);

  const subagentCandidates = findClaudeSubagentTranscriptCandidates(transcript);
  const stats = transcriptSetStats(transcript, subagentCandidates);
  const cursor = S.getSessionUsageCursor(row.id);
  const sameFile = cursor?.transcript_path === stats.transcriptPath;
  const needsContextBackfill = needsClaudeContextBackfill(row.id);
  const unchanged =
    !options.full &&
    !needsContextBackfill &&
    sameFile &&
    cursor.cursor_offset === stats.size &&
    cursor.mtime_ms === stats.mtimeMs;
  if (unchanged) {
    return {
      sessionId: row.id,
      report: {
        status: usageSyncStatus(0),
        transcriptPath: stats.transcriptPath,
        messages: 0,
        models: "stored",
      },
    };
  }

  const subagents = parseClaudeSubagentTranscripts(subagentCandidates);
  const canContinue = Boolean(
    !options.full &&
      !needsContextBackfill &&
      subagentCandidates.length === 0 &&
      sameFile &&
      cursor &&
      cursor.cursor_offset < transcript.size,
  );
  const offset = canContinue ? cursor!.cursor_offset : 0;

  // Every transcript read happens here, before the plan is applied: the usage rows, the message
  // dedupe table and the cursor that says how far the transcript was consumed must agree, so a
  // partial write would make the next sweep resume from a position it never actually reached.
  const parsed = canContinue
    ? parseClaudeUsageJsonl(readTranscriptSlice(transcript.path, offset))
    : [
        ...parseClaudeUsageJsonl(readTranscriptSlice(transcript.path, 0)),
        ...subagents.flatMap((subagent) => subagent.entries),
      ];
  const fresh = newUsageEntries(row.id, parsed, canContinue);
  const aggregated = aggregateUsage(fresh);
  const finalUsage = canContinue
    ? mergeModelUsage(S.listSessionUsage(row.id), aggregated)
    : aggregated;

  return {
    sessionId: row.id,
    // Continuing from a recorded offset only makes sense against the cursor that produced it.
    ...(canContinue ? { expect: { cursor } } : { resetUsage: true }),
    messageIds: fresh.map((entry) => entry.message_id),
    usage: aggregated,
    usageCosts: finalUsage.map((usage) => ({
      model: usage.model,
      costUsd: usage.cost_usd,
    })),
    ...(canContinue
      ? {}
      : { subagents: { rows: claudeSubagentUsage(subagents) } }),
    cursor: {
      transcriptPath: stats.transcriptPath,
      cursorOffset: stats.size,
      mtimeMs: stats.mtimeMs,
    },
    report: {
      status: usageSyncStatus(fresh.length),
      transcriptPath: stats.transcriptPath,
      messages: fresh.length,
      models: "stored",
    },
  };
}

// The transcript set is the main file plus its sidechains. Its identity, byte size and mtime decide
// whether the next sweep can resume instead of reparsing.
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

function parseClaudeSubagentTranscripts(
  files: ClaudeSubagentTranscriptCandidate[],
): ClaudeSubagentTranscript[] {
  return files
    .map(parseClaudeSubagentTranscript)
    .filter((x): x is ClaudeSubagentTranscript => x != null);
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

// Older rows predate context-window reporting. Re-import once a window is known for the model so the
// percentage appears, and stop asking after the model turns out to have none.
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
