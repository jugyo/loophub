import { worktreeRoot } from "../config.ts";
import { sessionRuntime } from "../session-runtime.ts";
import * as S from "../store.ts";
import {
  legacyWorktreePath,
  resolveWorktreeIdentity,
  worktreePath,
} from "../worktree-path.ts";

/** The PR worktree a session's agent ran in, and therefore wrote its transcripts under. */
export interface PullWorktreeTarget {
  cwd: string;
  pullIssueId: number;
  repoId: number;
}

export function pullWorktreeTarget(
  row: S.AgentSessionRow,
): PullWorktreeTarget | null {
  const target = S.listSessionLinkedTargets(row.id).find(
    (x) => x.kind === "pull",
  );
  if (!target) return null;
  const repo = S.getRepoById(target.repo_id);
  if (!repo) return null;
  const prRow = S.getIssue(repo.id, target.number);
  if (prRow?.kind !== "pull") return null;
  const pull = S.getPull(prRow.id);
  if (!pull) return null;
  const identity = resolveWorktreeIdentity(pull.head_ref, prRow.number);
  const cwd =
    identity.scheme === "legacy-issue"
      ? legacyWorktreePath(worktreeRoot(), repo.full_name, identity.number)
      : worktreePath(worktreeRoot(), repo.full_name, identity.number);
  return { cwd, pullIssueId: prRow.id, repoId: repo.id };
}

/**
 * Codex and Grok write transcripts per worktree rather than per session, so a PR's usage belongs to
 * one owner session: its primary dev session when that runs the same runtime, otherwise the first
 * linked session of that runtime.
 */
export interface WorktreeUsageTarget {
  cwd: string;
  ownerSessionId: string;
  pullIssueId: number;
}

/**
 * The runtime ids one sync module claims. Usually a single id, but OpenCode 1 and OpenCode 2 share
 * a data directory and DB, so they are one cohort: matching on a set keeps their sessions on a
 * single owner instead of double counting the same worktree aggregate once per id.
 */
export type UsageRuntimes = string | readonly string[];

function matchesRuntime(
  row: S.AgentSessionRow,
  runtime: UsageRuntimes,
): boolean {
  const actual = sessionRuntime(row);
  if (actual === null) return false;
  return typeof runtime === "string"
    ? actual === runtime
    : runtime.includes(actual);
}

export function worktreeUsageTarget(
  row: S.AgentSessionRow,
  runtime: UsageRuntimes,
): WorktreeUsageTarget | null {
  if (!matchesRuntime(row, runtime)) return null;
  const base = pullWorktreeTarget(row);
  if (!base) return null;
  return {
    cwd: base.cwd,
    pullIssueId: base.pullIssueId,
    ownerSessionId: worktreeUsageOwner(base.pullIssueId, runtime, row.id),
  };
}

function worktreeUsageOwner(
  pullIssueId: number,
  runtime: UsageRuntimes,
  fallbackSessionId: string,
): string {
  const primarySessionId = S.primaryDevSessionForPull(pullIssueId);
  const primary = primarySessionId ? S.getAgentSession(primarySessionId) : null;
  if (primary && matchesRuntime(primary, runtime)) return primarySessionId!;
  return (
    S.listSessionsForIssue(pullIssueId).find((session) =>
      matchesRuntime(session, runtime),
    )?.id ?? fallbackSessionId
  );
}

export function worktreeUsageTargetKey(target: WorktreeUsageTarget): string {
  return `${target.pullIssueId}\0${target.ownerSessionId}`;
}

/** Sessions whose stale per-session usage the owner's worktree aggregate replaces. */
export function supersededWorktreeSessions(
  target: WorktreeUsageTarget,
  runtime: UsageRuntimes,
): string[] {
  return S.listSessionsForIssue(target.pullIssueId)
    .filter(
      (session) =>
        session.id !== target.ownerSessionId &&
        matchesRuntime(session, runtime),
    )
    .map((session) => session.id);
}
