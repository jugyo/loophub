// Service layer: transport-neutral procedures over the store. Each procedure validates
// input (throwing ServiceError with an HTTP-style status), mutates the store, emits
// events, and returns serialized wire objects. The CLI calls these directly (S5); the
// JSON-RPC layer (S2) will wrap the same procedures. No HTTP/Request types leak in here.
import { spawn, spawnSync } from "node:child_process";
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
  devCostLimitUsd,
  updateAgentAutoModeOnBuild,
  updateAgentDefaultEffort,
  updateAgentDefaultModel,
  updateConfig,
  updateDevCostLimitUsd,
  worktreeRoot,
} from "../config.ts";
import { isServiceError, ServiceError } from "../errors.ts";
import { formatEvent, type LoopEvent } from "../event-hub.ts";
import { type FollowOptions, followEvents } from "../events-follow.ts";
import {
  branchExists,
  commitLog,
  commitsAhead,
  defaultBranch,
  diffFiles,
  diffStat,
  fileAtRef,
  git,
  mergePull as gitMergePull,
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
  type GithubPrStatusDeps,
  parseGithubIssueUrl,
  realGithubDeps,
  realGithubIssueDeps,
  realGithubPrStatusDeps,
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
  githubPrStatusJSON,
  githubPullJSON,
  handoffJSON,
  herdrPaneJSON,
  inboxMessageJSON,
  issueJSON,
  issueListItemJSON,
  labelJSON,
  pevrWorkflowJSON,
  pullJSON,
  relatedSessionsJSON,
  repoJSON,
  retroJSON,
  reviewCommentJSON,
  reviewJSON,
  scheduledTaskJSON,
  scheduledTaskRunJSON,
  sessionUsageJSON,
} from "../serialize.ts";
import type {
  ClaudeSubagentTranscript,
  ClaudeSubagentTranscriptCandidate,
  CodexRolloutScan,
  ModelUsage,
  UsageEntry,
} from "../session-usage.ts";
import {
  aggregateUsage,
  calculateCostUsd,
  claudeContextWindowForModel,
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
import {
  type HerdrAgent,
  type HerdrIssueWorkspace,
  type HerdrPullWorkspace,
  herdrIssueWorkspacesFromAgentList,
  herdrPullWorkspacesFromAgentList,
  NO_PANE_ID_PREFIX,
  paneRunsClaudeResume,
  parseHerdrAgentList,
  parseHerdrAgentPlacements,
  parseHerdrAgentRead,
  parseHerdrPaneKillTarget,
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
  buildScheduledTaskCommand,
  commandForHerdrLaunch,
  displayArg,
  HERDR_ID,
  type HerdrCmdRunner,
  herdrAgentFocusArgv,
  herdrCommandLine,
  herdrPaneCloseArgv,
  herdrPaneSendKeysArgv,
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

export { pevrWorkflowJSON };

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
  GithubPrStatusDeps,
  HerdrAgent,
  HerdrCmdRunner,
  HerdrIssueWorkspace,
  HerdrPullWorkspace,
  LoopEvent,
  MergeMode,
  ModelUsage,
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
  buildScheduledTaskCommand,
  calculateCostUsd,
  classifyWorktree,
  claudeContextWindowForModel,
  codingAgent,
  commandForHerdrLaunch,
  commentJSON,
  commitLog,
  commitsAhead,
  configDir,
  createClaudeTranscriptIndex,
  createCodexRolloutScan,
  createHash,
  databaseSize,
  decideResume,
  defaultBranch,
  devCostLimitUsd,
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
  git,
  githubIssueJSON,
  githubPrStatusJSON,
  githubPullJSON,
  gitMergePull,
  HERDR_ID,
  handoffJSON,
  herdrAgentFocusArgv,
  herdrCommandLine,
  herdrIssueWorkspacesFromAgentList,
  herdrPaneCloseArgv,
  herdrPaneJSON,
  herdrPaneSendKeysArgv,
  herdrPullWorkspacesFromAgentList,
  herdrSessionName,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrTabFocusArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceCreateArgv,
  herdrWorkspaceFocusArgv,
  inboxMessageJSON,
  isGithubRemoteUrl,
  isGitRepo,
  isRetroStatus,
  isServiceError,
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
  parseHerdrPaneKillTarget,
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
  realGithubPrStatusDeps,
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
  revParse,
  rmSync,
  ServiceError,
  scheduledTaskJSON,
  scheduledTaskRunJSON,
  sessionRuntime,
  sessionUsageJSON,
  spawn,
  spawnSync,
  sweepPullUpdates,
  tableRowCounts,
  updateAgentAutoModeOnBuild,
  updateAgentDefaultEffort,
  updateAgentDefaultModel,
  updateConfig,
  updateDevCostLimitUsd,
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

export function assertExistingLocalBranch(
  repoPath: string,
  branch: string,
  label = "target_branch",
): void {
  assertOptionSafeLocalBranchName(branch, label);
  if (!localBranchExists(repoPath, branch)) {
    throw new ServiceError(
      422,
      `${label} must name an existing local branch: ${branch}`,
    );
  }
}

export function ensureLocalBranchFromDefault(
  repoPath: string,
  branch: string,
  defaultBranch: string,
  label = "target_branch",
): void {
  assertCreatableLocalBranchName(branch, label);
  if (localBranchExists(repoPath, branch)) return;
  assertOptionSafeLocalBranchName(defaultBranch, "default_branch");
  if (!localBranchExists(repoPath, defaultBranch)) {
    throw new ServiceError(
      422,
      `cannot resolve default branch "${defaultBranch}"`,
    );
  }
  const result = spawnSync(
    "git",
    [
      "-C",
      repoPath,
      "branch",
      "--no-track",
      "--",
      branch,
      `refs/heads/${defaultBranch}`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new ServiceError(
      422,
      `failed to create ${label} "${branch}" from default branch "${defaultBranch}": ${result.stderr.trim() || result.stdout.trim() || "git branch failed"}`,
    );
  }
}

function assertOptionSafeLocalBranchName(branch: string, label: string): void {
  if (
    branch.startsWith("-") ||
    /[\0\r\n]/.test(branch) ||
    isRevisionSpecialBranchName(branch)
  ) {
    throw new ServiceError(422, `${label} must be a local branch name`);
  }
}

function isRevisionSpecialBranchName(branch: string): boolean {
  return (
    branch === "@" ||
    branch === "HEAD" ||
    branch.endsWith("/HEAD") ||
    /^[A-Z_]+_HEAD$/.test(branch)
  );
}

function assertCreatableLocalBranchName(branch: string, label: string): void {
  assertOptionSafeLocalBranchName(branch, label);
  const result = spawnSync(
    "git",
    ["check-ref-format", `refs/heads/${branch}`],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new ServiceError(422, `${label} must be a local branch name`);
  }
}

function localBranchExists(repoPath: string, branch: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { encoding: "utf8" },
  );
  return result.status === 0;
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
