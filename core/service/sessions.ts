import type {
  ClaudeSubagentTranscript,
  ClaudeSubagentTranscriptCandidate,
  CodexRolloutScan,
  UsageEntry,
} from "./shared.ts";
import {
  actorFor,
  agentSessionJSON,
  aggregateUsage,
  calculateCostUsd,
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

// ===== agent sessions =====
function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

interface CodexUsageTargetContext {
  peersByPullId: Map<
    number,
    {
      counts: Map<number, number>;
      sortedStarts: number[];
    }
  >;
}

function codexPeerStartsForPull(
  pullId: number,
  context?: CodexUsageTargetContext,
): {
  counts: Map<number, number>;
  sortedStarts: number[];
} {
  const cached = context?.peersByPullId.get(pullId);
  if (cached) return cached;
  const counts = new Map<number, number>();
  for (const session of S.listSessionsForIssue(pullId)) {
    if (sessionRuntime(session) !== RUNTIME_CODEX) continue;
    const startedAtMs = timestampMs(session.created_at);
    if (startedAtMs == null) continue;
    counts.set(startedAtMs, (counts.get(startedAtMs) ?? 0) + 1);
  }
  const result = {
    counts,
    sortedStarts: [...counts.keys()].sort((a, b) => a - b),
  };
  context?.peersByPullId.set(pullId, result);
  return result;
}

function codexUsageTarget(
  row: S.AgentSessionRow,
  context?: CodexUsageTargetContext,
): {
  cwd: string;
  startedAtMs: number;
  endedBeforeMs: number | null;
} | null {
  if (sessionRuntime(row) !== RUNTIME_CODEX) return null;
  const startedAtMs = timestampMs(row.created_at);
  if (startedAtMs == null) return null;

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
    const peerStarts = codexPeerStartsForPull(prRow.id, context);
    if ((peerStarts.counts.get(startedAtMs) ?? 0) > 1) return null;
    const nextStart =
      peerStarts.sortedStarts.find((ms: number): boolean => ms > startedAtMs) ??
      null;
    return { cwd, startedAtMs, endedBeforeMs: nextStart };
  } catch {
    return null;
  }
}

const codexSessionScanFingerprints = new Map<string, string>();

function pruneCodexSessionScanFingerprints(sessionIds: Set<string>): void {
  for (const sessionId of codexSessionScanFingerprints.keys()) {
    if (!sessionIds.has(sessionId))
      codexSessionScanFingerprints.delete(sessionId);
  }
}

function codexSessionScanFingerprint(
  scan: CodexRolloutScan,
  target: {
    cwd: string;
    startedAtMs: number;
    endedBeforeMs: number | null;
  },
): string {
  return [
    scan.fingerprint,
    target.cwd,
    target.startedAtMs,
    target.endedBeforeMs ?? "",
  ].join("\0");
}

function codexCursorMatchesScan(
  cursor: S.SessionUsageCursorRow | null,
  scan: CodexRolloutScan,
): boolean {
  if (!cursor?.transcript_path) return false;
  const paths = String(cursor.transcript_path).split("\n").filter(Boolean);
  if (paths.length === 0) return false;

  const byPath = new Map(scan.files.map((file) => [file.path, file]));
  let size = 0;
  let mtimeMs = 0;
  for (const path of paths) {
    const file = byPath.get(path);
    if (!file) return false;
    size += file.size;
    mtimeMs = Math.max(mtimeMs, file.mtimeMs);
  }

  return cursor.cursor_offset === size && cursor.mtime_ms === mtimeMs;
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

export const sessions = {
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

    const codexTargetContext: CodexUsageTargetContext = {
      peersByPullId: new Map(),
    };
    const codexTargets = new Map<
      string,
      {
        cwd: string;
        startedAtMs: number;
        endedBeforeMs: number | null;
      }
    >();
    for (const row of rows) {
      if (sessionRuntime(row) !== RUNTIME_CODEX) continue;
      const target = codexUsageTarget(row, codexTargetContext);
      if (target) codexTargets.set(row.id, target);
    }
    const codexScan =
      codexTargets.size > 0
        ? createCodexRolloutScan(input.codexSessionsDir)
        : null;
    if (!input.sessionId) {
      pruneCodexSessionScanFingerprints(new Set(rows.map((row) => row.id)));
    }
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
        const target = codexTargets.get(row.id);
        if (!target) {
          S.resetSessionUsage(row.id);
          codexSessionScanFingerprints.delete(row.id);
          return {
            session_id: row.id,
            status: "missing",
            messages: 0,
            models: [],
          };
        }

        const cursor = S.getSessionUsageCursor(row.id);
        const scanFingerprint =
          codexScan && codexSessionScanFingerprint(codexScan, target);
        if (
          !input.full &&
          codexScan &&
          scanFingerprint &&
          codexSessionScanFingerprints.get(row.id) === scanFingerprint &&
          codexCursorMatchesScan(cursor, codexScan)
        ) {
          if (!S.hasSessionSubagentUsage(row.id)) {
            const rollouts = findCodexRollouts({
              ...target,
              sessionsDir: input.codexSessionsDir,
              scan: codexScan,
            });
            saveCodexSubagentUsage(row.id, rollouts);
          }
          return {
            session_id: row.id,
            status: "skipped",
            transcript_path: cursor!.transcript_path,
            messages: 0,
            models: S.listSessionUsage(row.id).map(sessionUsageJSON),
          };
        }

        const rollouts = findCodexRollouts({
          ...target,
          sessionsDir: input.codexSessionsDir,
          scan: codexScan ?? undefined,
        });
        if (rollouts.length === 0) {
          S.resetSessionUsage(row.id);
          codexSessionScanFingerprints.delete(row.id);
          return {
            session_id: row.id,
            status: "missing",
            messages: 0,
            models: [],
          };
        }

        const transcriptPath = rollouts.map((x) => x.path).join("\n");
        const size = rollouts.reduce((sum, x) => sum + x.size, 0);
        const mtimeMs = Math.max(...rollouts.map((x) => x.mtimeMs));
        const unchanged =
          !input.full &&
          cursor?.transcript_path === transcriptPath &&
          cursor.cursor_offset === size &&
          cursor.mtime_ms === mtimeMs;
        if (unchanged) {
          if (!S.hasSessionSubagentUsage(row.id)) {
            saveCodexSubagentUsage(row.id, rollouts);
          }
          if (scanFingerprint) {
            codexSessionScanFingerprints.set(row.id, scanFingerprint);
          }
          return {
            session_id: row.id,
            status: "skipped",
            transcript_path: transcriptPath,
            messages: 0,
            models: S.listSessionUsage(row.id).map(sessionUsageJSON),
          };
        }

        S.resetSessionUsage(row.id);
        const fresh = rollouts.flatMap((x) => x.entries);
        for (const usage of aggregateUsage(fresh)) {
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
        S.upsertSessionUsageCursor({
          sessionId: row.id,
          transcriptPath,
          cursorOffset: size,
          mtimeMs,
        });
        if (scanFingerprint) {
          codexSessionScanFingerprints.set(row.id, scanFingerprint);
        }

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
      const unchanged =
        !input.full &&
        sameFile &&
        cursor.cursor_offset === transcriptStats.size &&
        cursor.mtime_ms === transcriptStats.mtimeMs;
      if (unchanged) {
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
        subagentCandidates.length === 0 &&
        sameFile &&
        cursor &&
        cursor.cursor_offset < transcript.size;
      const offset = canContinue ? cursor.cursor_offset : 0;
      if (!canContinue) S.resetSessionUsage(row.id);

      const parsed = canContinue
        ? parseClaudeUsageJsonl(readTranscriptSlice(transcript.path, offset))
        : [
            ...parseClaudeUsageJsonl(readTranscriptSlice(transcript.path, 0)),
            ...subagents.flatMap((subagent) => subagent.entries),
          ];
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
