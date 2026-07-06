// Service layer: transport-neutral procedures over the store. Each procedure validates
// input (throwing ServiceError with an HTTP-style status), mutates the store, emits
// events, and returns serialized wire objects. The CLI calls these directly (S5); the
// JSON-RPC layer (S2) will wrap the same procedures. No HTTP/Request types leak in here.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  agentEffort,
  agentModel,
  autoModeOnBuild,
  type CodingAgent,
  codingAgent,
  configDir,
  updateAgentAutoModeOnBuild,
  updateAgentDefaultEffort,
  updateAgentDefaultModel,
  updateConfig,
  worktreeRoot,
} from "../config.ts";
import { isServiceError, ServiceError } from "../errors.ts";
import { formatEvent, type LoopEvent } from "../event-hub.ts";
import { type FollowOptions, followEvents } from "../events-follow.ts";
import {
  branchExists,
  commitLog,
  commitParents,
  commitsAhead,
  defaultBranch,
  diffFiles,
  diffStat,
  fileAtRef,
  mergePull as gitMergePull,
  undoMainMerge as gitUndoMainMerge,
  isGitRepo,
  pathInDiff,
  remoteUrl,
  revParse,
  worktreeList,
  worktreeListChecked,
  worktreePrune,
  worktreeRemove,
  worktreeStatus,
} from "../git.ts";
import {
  type GithubDeps,
  type GithubIssueDeps,
  parseGithubIssueUrl,
  realGithubDeps,
  realGithubIssueDeps,
} from "../github.ts";
import { parseClosingIssueNumber } from "../links.ts";
import {
  effectiveMergeMode,
  isGithubRemoteUrl,
  type MergeMode,
  normalizeMergeMode,
  parseGithubPullNumber,
} from "../merge-mode.ts";
import {
  decideResume,
  ENV_ISSUE_CREATE_HERDR_LAUNCH,
  RUNTIME_CLAUDE_CODE,
  RUNTIME_CODEX,
  resolveRuntimeResume,
  resolveWorktreeIdentity,
  sessionRuntime,
} from "../resume.ts";
import {
  isRetroStatus,
  RetroValidationError,
  validateFindings,
  validateRubric,
} from "../retro.ts";
import {
  agentSessionJSON,
  commentJSON,
  githubIssueJSON,
  githubPullJSON,
  handoffJSON,
  herdrPaneJSON,
  issueGroupJSON,
  issueJSON,
  issueListItemJSON,
  labelJSON,
  pullJSON,
  relatedSessionsJSON,
  repoJSON,
  retroJSON,
  reviewCommentJSON,
  reviewJSON,
  reviewNoteJSON,
  sessionUsageJSON,
} from "../serialize.ts";
import type {
  ClaudeSubagentTranscript,
  ClaudeSubagentTranscriptCandidate,
  CodexRolloutScan,
  UsageEntry,
} from "../session-usage.ts";
import {
  aggregateUsage,
  calculateCostUsd,
  createClaudeTranscriptIndex,
  createCodexRolloutScan,
  findClaudeSubagentTranscriptCandidates,
  findClaudeSubagentTranscripts,
  findClaudeTranscript,
  findCodexRollouts,
  parseClaudeSubagentTranscript,
  parseClaudeUsageJsonl,
  readTranscriptSlice,
} from "../session-usage.ts";
import { databaseSize, repoCounts, tableRowCounts } from "../stats.ts";
import * as S from "../store.ts";
import { parseHerdrInactiveCleanupCandidates } from "../terminal/herdr-inactive-cleanup.ts";
import {
  type HerdrAgent,
  type HerdrPullWorkspace,
  herdrPullWorkspacesFromAgentList,
  NO_PANE_ID_PREFIX,
  paneRunsClaudeResume,
  parseHerdrAgentList,
  parseHerdrAgentPlacements,
  parseHerdrAgentRead,
  parseHerdrPaneLayout,
  parseHerdrPaneProcessInfo,
  parseHerdrSessionList,
  parseHerdrTabList,
  parseHerdrWorkspaceList,
  reposWithRunningSession,
} from "../terminal/herdr-status.ts";
import {
  acquireHerdrWorktreeTab as acquireHerdrWorktreeTabCore,
  buildHerdrLaunchPlan,
  commandForHerdrLaunch,
  displayArg,
  HERDR_ID,
  type HerdrCmdRunner,
  herdrAgentFocusArgv,
  herdrCommandLine,
  herdrPaneCloseArgv,
  herdrSessionName,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrTabFocusArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceCreateArgv,
  herdrWorkspaceFocusArgv,
  parseHerdrAgentPaneId,
  parseHerdrRootPaneId,
  parseHerdrTabId,
  parseHerdrWorkspaceId,
  type TerminalLaunchRepo,
} from "../terminal/terminal-launch.ts";
import { sweepPullUpdates } from "../watcher.ts";
import {
  legacyWorktreePath,
  worktreeBranch,
  worktreePath,
} from "../worktree-path.ts";
import {
  classifyWorktree,
  issueNumberFromBranch,
  porcelainIsDirty,
  prNumberFromBranch,
} from "../worktree-prune.ts";

export * as S from "../store.ts";
export type {
  ClaudeSubagentTranscript,
  ClaudeSubagentTranscriptCandidate,
  CodexRolloutScan,
  CodingAgent,
  FollowOptions,
  GithubDeps,
  GithubIssueDeps,
  HerdrAgent,
  HerdrCmdRunner,
  HerdrPullWorkspace,
  LoopEvent,
  MergeMode,
  TerminalLaunchRepo,
  UsageEntry,
};
export {
  acquireHerdrWorktreeTabCore,
  agentEffort,
  agentModel,
  agentSessionJSON,
  aggregateUsage,
  autoModeOnBuild,
  branchExists,
  buildHerdrLaunchPlan,
  calculateCostUsd,
  classifyWorktree,
  codingAgent,
  commandForHerdrLaunch,
  commentJSON,
  commitLog,
  commitParents,
  commitsAhead,
  configDir,
  createClaudeTranscriptIndex,
  createCodexRolloutScan,
  createHash,
  databaseSize,
  decideResume,
  defaultBranch,
  diffFiles,
  diffStat,
  displayArg,
  ENV_ISSUE_CREATE_HERDR_LAUNCH,
  effectiveMergeMode,
  existsSync,
  fileAtRef,
  findClaudeSubagentTranscriptCandidates,
  findClaudeSubagentTranscripts,
  findClaudeTranscript,
  findCodexRollouts,
  followEvents,
  formatEvent,
  githubIssueJSON,
  githubPullJSON,
  gitMergePull,
  gitUndoMainMerge,
  HERDR_ID,
  handoffJSON,
  herdrAgentFocusArgv,
  herdrCommandLine,
  herdrPaneCloseArgv,
  herdrPaneJSON,
  herdrPullWorkspacesFromAgentList,
  herdrSessionName,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrTabFocusArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceCreateArgv,
  herdrWorkspaceFocusArgv,
  isGithubRemoteUrl,
  isGitRepo,
  isRetroStatus,
  isServiceError,
  issueGroupJSON,
  issueJSON,
  issueListItemJSON,
  issueNumberFromBranch,
  join,
  labelJSON,
  legacyWorktreePath,
  lstatSync,
  NO_PANE_ID_PREFIX,
  normalizeMergeMode,
  paneRunsClaudeResume,
  parseClaudeSubagentTranscript,
  parseClaudeUsageJsonl,
  parseClosingIssueNumber,
  parseGithubIssueUrl,
  parseGithubPullNumber,
  parseHerdrAgentList,
  parseHerdrAgentPaneId,
  parseHerdrAgentPlacements,
  parseHerdrAgentRead,
  parseHerdrInactiveCleanupCandidates,
  parseHerdrPaneLayout,
  parseHerdrPaneProcessInfo,
  parseHerdrRootPaneId,
  parseHerdrSessionList,
  parseHerdrTabId,
  parseHerdrTabList,
  parseHerdrWorkspaceId,
  parseHerdrWorkspaceList,
  pathInDiff,
  porcelainIsDirty,
  prNumberFromBranch,
  pullJSON,
  RetroValidationError,
  RUNTIME_CLAUDE_CODE,
  RUNTIME_CODEX,
  randomUUID,
  readdirSync,
  readTranscriptSlice,
  realGithubDeps,
  realGithubIssueDeps,
  realpathSync,
  relatedSessionsJSON,
  remoteUrl,
  repoCounts,
  repoJSON,
  reposWithRunningSession,
  resolve,
  resolveRuntimeResume,
  resolveWorktreeIdentity,
  retroJSON,
  reviewCommentJSON,
  reviewJSON,
  reviewNoteJSON,
  revParse,
  rmSync,
  ServiceError,
  sessionRuntime,
  sessionUsageJSON,
  spawn,
  sweepPullUpdates,
  tableRowCounts,
  updateAgentAutoModeOnBuild,
  updateAgentDefaultEffort,
  updateAgentDefaultModel,
  updateConfig,
  validateFindings,
  validateRubric,
  worktreeBranch,
  worktreeList,
  worktreeListChecked,
  worktreePath,
  worktreePrune,
  worktreeRemove,
  worktreeRoot,
  worktreeStatus,
};

export const MAX_EVENTS_PER_PAGE = 100;
export const DEFAULT_LIST_PER_PAGE = 30;
export const MAX_LIST_PER_PAGE = 100;

// ---- shared helpers ----
export function repoOr404(name: string): S.Repo {
  const [owner, rname] = S.splitName(name);
  const r = S.getRepo(owner, rname);
  if (!r) throw new ServiceError(404, "Not Found");
  return r;
}

export function ensureWritable(r: S.Repo): void {
  if (S.isArchived(r)) throw new ServiceError(403, "Repository is archived");
}

export function actorFor(sessionId: string | null | undefined): string {
  return S.authorFromSession(sessionId) ?? "unknown";
}

// Resolve symlinks so worktree paths from `git worktree list` (which canonicalizes, e.g.
// /var → /private/var on macOS) compare equal to a caller's cwd. Falls back to a plain
// absolute path when the target no longer exists.
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function issueOr404(
  r: S.Repo,
  number: number,
  kind?: "issue" | "pull",
): S.IssueRow {
  const row = S.getIssue(r.id, number);
  if (!row || (kind && row.kind !== kind))
    throw new ServiceError(404, "Not Found");
  return row;
}

export function clampPerPage(
  perPage: number | undefined,
  def: number,
  max: number,
): number {
  let v = Number(perPage ?? def);
  if (!Number.isFinite(v) || v < 1) v = def;
  return Math.min(v, max);
}

export function paginate<T>(rows: T[], perPage: number, page: number): T[] {
  const offset = (page - 1) * perPage;
  return rows.slice(offset, offset + perPage);
}
