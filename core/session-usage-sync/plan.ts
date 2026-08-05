import type { SessionUsageWire } from "../serialize.ts";
import type { ModelUsage, SubagentUsage } from "../session-usage.ts";
import type * as S from "../store.ts";

export type SessionUsageSyncStatus = "updated" | "skipped" | "missing";

export interface SessionUsageSyncRow {
  session_id: string;
  status: SessionUsageSyncStatus;
  transcript_path?: string;
  messages: number;
  models: SessionUsageWire[];
}

/** Discovery roots a caller may override; tests point them at fixture directories. */
export interface SessionUsageSyncOptions {
  full?: boolean;
  projectsDir?: string;
  codexSessionsDir?: string;
  grokSessionsDir?: string;
  cursorProjectsDir?: string;
}

/**
 * What the plan assumes the DB still holds. The executor re-reads it inside the cohort transaction
 * and aborts before writing when a concurrent sweep moved the session on.
 */
export interface SessionUsageExpectation {
  usage?: readonly ModelUsage[];
  cursor?: S.SessionUsageCursorRow | null;
}

export interface SubagentUsagePlan {
  /** Drop the session's existing rows of this kind before upserting `rows`. */
  deleteKind?: string;
  rows: SubagentUsage[];
}

/** How one session is reported back once its plan is applied. */
export interface SessionUsageReport {
  status: SessionUsageSyncStatus;
  transcriptPath?: string;
  messages: number;
  /** "stored" serializes the post-apply usage rows; "none" reports an empty model list. */
  models: "stored" | "none";
}

/**
 * Every DB change one session's sync makes. Runtime modules build these from filesystem and store
 * reads alone, so a plan is inspectable and side-effect free; the executor owns all writes.
 */
export interface SessionUsagePlan {
  sessionId: string;
  expect?: SessionUsageExpectation;
  /** Replace the identifier the runtime reported for this session, and announce the change. */
  externalSession?: string;
  /** Drop the session's usage, subagent, cursor and dedupe rows before applying the rest. */
  resetUsage?: boolean;
  /** Peer sessions whose per-session usage this plan's worktree aggregate supersedes. */
  clearUsageFor?: string[];
  messageIds?: string[];
  usage?: ModelUsage[];
  usageCosts?: { model: string; costUsd: number | null }[];
  subagents?: SubagentUsagePlan;
  cursor?: { transcriptPath: string; cursorOffset: number; mtimeMs: number };
  report: SessionUsageReport;
}

/** Plans applied together in a single transaction. */
export interface SessionUsageSyncCohort {
  key: string;
  plans: SessionUsagePlan[];
}

/**
 * One runtime's ownership of target selection, transcript discovery, correlation and plan building.
 * A module reads the filesystem and the store; it never writes.
 */
export interface SessionUsageSyncModule {
  /** Whether this module syncs the session. Modules are consulted in registration order. */
  owns(row: S.AgentSessionRow): boolean;
  plan(
    rows: S.AgentSessionRow[],
    options: SessionUsageSyncOptions,
  ): SessionUsageSyncCohort[];
}

export function usageSyncStatus(messages: number): SessionUsageSyncStatus {
  return messages > 0 ? "updated" : "skipped";
}

/**
 * No transcript resolved for the session. `resetUsage` drops usage that an earlier sweep attributed
 * to a target that no longer exists; runtimes whose transcripts merely moved out of reach keep it.
 */
export function missingUsagePlan(
  sessionId: string,
  resetUsage = false,
): SessionUsagePlan {
  return {
    sessionId,
    ...(resetUsage ? { resetUsage: true } : {}),
    report: { status: "missing", messages: 0, models: "none" },
  };
}

export function modelUsageEqualsStored(
  expected: readonly ModelUsage[],
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

export function usageCursorEquals(
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
