import { RUNTIME_CURSOR, sessionRuntime } from "../session-runtime.ts";
import {
  type CursorTranscriptCandidate,
  findCursorTranscripts,
} from "../session-usage.ts";
import * as S from "../store.ts";
import {
  missingUsagePlan,
  type SessionUsagePlan,
  type SessionUsageSyncCohort,
  type SessionUsageSyncModule,
  type SessionUsageSyncOptions,
  type SessionUsageSyncStatus,
} from "./plan.ts";
import { pullWorktreeTarget } from "./targets.ts";

// Cursor names a chat only after it starts, so a session launched at T is paired with the first
// unclaimed transcript created around T. Beyond this window the transcript belongs to a later run.
const TRANSCRIPT_CORRELATION_WINDOW_MS = 120_000;

/**
 * Cursor usage sync. Cursor does not accept a caller-supplied chat id, so transcripts are found by
 * the cwd the agent ran in — a PR worktree for dev sessions, the repository itself for issue-create
 * sessions — and correlated to sessions by launch order within that cwd.
 *
 * Cursor CLI transcripts identify chats but do not expose token counts, so a sync records the chat
 * identifier and clears any usage an earlier sweep inferred.
 */
export const cursorUsageSync: SessionUsageSyncModule = {
  owns: (row) => sessionRuntime(row) === RUNTIME_CURSOR,

  plan(rows, options) {
    const targets = new Map<string, CursorUsageTarget>();
    const targetKeyBySession = new Map<string, string>();
    for (const row of rows) {
      const target = cursorUsageTarget(row);
      if (!target) continue;
      const key = cursorTargetKey(target);
      if (!targets.has(key)) targets.set(key, target);
      targetKeyBySession.set(row.id, key);
    }

    const transcriptBySession = new Map<string, CursorTranscriptCandidate>();
    const externalSessionBySession = new Map<string, string>();
    for (const [key, target] of targets) {
      // One directory scan per cwd, shared by every session correlated against it.
      const correlation = correlateCursorTarget(
        target,
        key,
        rows,
        targetKeyBySession,
        options,
      );
      for (const [sessionId, transcript] of correlation.transcripts) {
        transcriptBySession.set(sessionId, transcript);
      }
      for (const [sessionId, external] of correlation.externalSessions) {
        externalSessionBySession.set(sessionId, external);
      }
    }

    // Sessions that draw from the same transcript pool commit together: a chat id conflict must not
    // leave one peer renamed and the rest holding the identifiers it invalidated.
    const cohorts = new Map<string, SessionUsageSyncCohort>();
    for (const row of rows) {
      const targetKey = targetKeyBySession.get(row.id);
      const cohortKey = targetKey
        ? `cursor:${targetKey}`
        : `cursor:untargeted:${row.id}`;
      const cohort = cohorts.get(cohortKey) ?? { key: cohortKey, plans: [] };
      cohorts.set(cohortKey, cohort);
      cohort.plans.push(
        planCursorSession(
          row,
          transcriptBySession.get(row.id),
          externalSessionBySession.get(row.id),
        ),
      );
    }
    return [...cohorts.values()];
  },
};

function planCursorSession(
  row: S.AgentSessionRow,
  transcript: CursorTranscriptCandidate | undefined,
  externalSession: string | undefined,
): SessionUsagePlan {
  if (!transcript) return missingUsagePlan(row.id, true);
  const stored = S.listSessionUsage(row.id);
  const status: SessionUsageSyncStatus =
    externalSession !== undefined || stored.length > 0 ? "updated" : "skipped";
  return {
    sessionId: row.id,
    expect: { usage: stored },
    ...(externalSession ? { externalSession } : {}),
    resetUsage: true,
    report: {
      status,
      transcriptPath: transcript.path,
      messages: 0,
      models: "none",
    },
  };
}

/** The cwd whose Cursor transcripts a session's chat is found in. */
interface CursorUsageTarget {
  cwd: string;
  pullIssueId: number | null;
}

function cursorUsageTarget(row: S.AgentSessionRow): CursorUsageTarget | null {
  if (sessionRuntime(row) !== RUNTIME_CURSOR) return null;
  const pull = pullWorktreeTarget(row);
  if (pull) return { cwd: pull.cwd, pullIssueId: pull.pullIssueId };

  // Issue-create sessions run in the repository checkout, not a worktree.
  const target = S.listSessionLinkedTargets(row.id).find(
    (linked) => linked.kind === "issue",
  );
  if (!target) return null;
  const repo = S.getRepoById(target.repo_id);
  if (!repo) return null;
  const issue = S.getIssue(repo.id, target.number);
  if (issue?.kind !== "issue") return null;
  return { cwd: repo.local_path, pullIssueId: null };
}

function cursorTargetKey(target: CursorUsageTarget): string {
  return target.pullIssueId === null
    ? `repo\0${target.cwd}`
    : `pull\0${target.pullIssueId}`;
}

interface CursorCorrelation {
  transcripts: Map<string, CursorTranscriptCandidate>;
  externalSessions: Map<string, string>;
}

function correlateCursorTarget(
  target: CursorUsageTarget,
  targetKey: string,
  rows: S.AgentSessionRow[],
  targetKeyBySession: Map<string, string>,
  options: SessionUsageSyncOptions,
): CursorCorrelation {
  const out: CursorCorrelation = {
    transcripts: new Map(),
    externalSessions: new Map(),
  };
  const transcripts = findCursorTranscripts({
    cwd: target.cwd,
    projectsDir: options.cursorProjectsDir,
  }).sort((a, b) => a.createdAtMs - b.createdAtMs);
  const sessions = (
    target.pullIssueId
      ? S.listSessionsForIssue(target.pullIssueId)
      : rows.filter(
          (session) => targetKeyBySession.get(session.id) === targetKey,
        )
  )
    .filter((session) => sessionRuntime(session) === RUNTIME_CURSOR)
    // listSessionsForIssue is newest-link-first (including a rowid tiebreaker). Reverse it before
    // the stable timestamp sort so sessions launched in the same second retain their actual launch
    // order and pair with transcript creation order.
    .reverse()
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const sessionStartTimes = sessions.map((session) =>
    Date.parse(session.created_at),
  );
  const distinctStartTimes = [...new Set(sessionStartTimes)];
  const nextStartedAtByStartedAt = new Map(
    distinctStartTimes.map((startedAt, index) => [
      startedAt,
      Math.min(
        distinctStartTimes[index + 1] ?? Number.POSITIVE_INFINITY,
        startedAt + TRANSCRIPT_CORRELATION_WINDOW_MS,
      ),
    ]),
  );
  const claimed = new Set<string>();
  const exactBySession = new Map<string, CursorTranscriptCandidate>();
  for (const session of sessions) {
    // Cursor headless output provides the authoritative chat id. Reserve that transcript before
    // chronological matching so another same-cwd session cannot claim it first.
    if (session.external_session === session.id) continue;
    const exact = transcripts.find(
      (candidate) => candidate.sessionId === session.external_session,
    );
    if (!exact || claimed.has(exact.sessionId)) continue;
    claimed.add(exact.sessionId);
    exactBySession.set(session.id, exact);
  }
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const startedAt = sessionStartTimes[index];
    const nextStartedAt = nextStartedAtByStartedAt.get(startedAt)!;
    const hasAuthoritativeId = session.external_session !== session.id;
    const transcript =
      exactBySession.get(session.id) ??
      (hasAuthoritativeId
        ? undefined
        : transcripts.find(
            (candidate) =>
              !claimed.has(candidate.sessionId) &&
              candidate.createdAtMs >= startedAt - 5_000 &&
              candidate.createdAtMs < nextStartedAt,
          ));
    if (!transcript) continue;
    if (!hasAuthoritativeId) claimed.add(transcript.sessionId);
    out.transcripts.set(session.id, transcript);
    if (session.external_session !== transcript.sessionId)
      out.externalSessions.set(session.id, transcript.sessionId);
  }
  return out;
}
