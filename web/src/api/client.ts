// JSON-RPC 2.0 client for the LoopHub lh-web server (single endpoint POST /rpc).
//
// The contract is language-neutral (see docs/rpc-contract.json); this module is written
// against it and never imports core types — the wire shapes live in ./types. The SPA is
// always served same-origin by its own lh-web (issue #1669), so requests are same-origin
// ("" base); there is no separate-backend override.

import { recordRpc } from "@/lib/debug-log";
import { errorMessage } from "@/lib/error-message";
import { getSessionId } from "@/lib/session";
import type {
  AcceptanceCriterionDetail,
  AgentSession,
  CodingAgent,
  DashboardOverview,
  DiffFeedbackList,
  DiffFeedbackMessage,
  DiffFeedbackThread,
  FileAtRef,
  GithubPrStatus,
  GithubPull,
  GlobalSettings,
  Handoff,
  HerdrAgentRead,
  HerdrSessions,
  Issue,
  IssueComment,
  IssueDetailPage,
  IssueListPage,
  IssueRefKind,
  Label,
  LoopEvent,
  Notification,
  PullDetailPage,
  PullDiff,
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
  PullUsage,
  Repo,
  RepoAgentConfig,
  RepoGithubPrExportExtraPrompt,
  RepoMergeMode,
  RepoOriginSync,
  SearchResult,
  Stats,
  TerminalLaunchResult,
  Theme,
  WebConfig,
  WorkerCompatibility,
  Workflow,
  WorkflowContracts,
  WorkflowRunAgentCost,
  WorkflowRunHistoryEvent,
  WorkflowRunState,
  WorkflowRunTotalCost,
  Workspace,
} from "./types";

/** Server base. Always same-origin: the SPA is served by its own lh-web. */
export const API_BASE = "";

export const RPC_URL = `${API_BASE}/rpc`;

interface InitializeResult {
  webConfig: WebConfig;
}

// Mirrors core/errors.ts's ServiceErrorData — an allowlisted shape, not Record<string, unknown>,
// so a server-side error can only ever carry known-safe fields across the wire.
interface ApiErrorData {
  command?: string;
  session?: string;
}

export class ApiError extends Error {
  status: number;
  // Extra fields ServiceError attached server-side (e.g. `command` — the Herdr command a caller
  // can re-run locally). Absent for most errors.
  data?: ApiErrorData;
  constructor(status: number, message: string, data?: ApiErrorData) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

interface RpcError {
  code: number;
  message: string;
  data?: { status?: number } & ApiErrorData;
}

// Map a JSON-RPC error to an HTTP-style status so callers keep checking err.status
// (e.g. 409 merge conflict). ServiceError carries the real status in error.data.status.
function statusFromError(error: RpcError): number {
  if (error.data && typeof error.data.status === "number")
    return error.data.status;
  switch (error.code) {
    case -32700: // parse error
    case -32600: // invalid request
      return 400;
    case -32601: // method not found
      return 404;
    case -32602: // invalid params
      return 422;
    default:
      return 500;
  }
}

let nextId = 1;

/** Call a JSON-RPC method and return its result, throwing ApiError on transport/RPC error. */
export async function rpc<T>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const startedAt = performance.now();
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    if (!res.ok) throw new ApiError(res.status, res.statusText);
    const body = (await res.json()) as { result?: T; error?: RpcError };
    if (body.error) {
      const { status: _status, ...data } = body.error.data ?? {};
      throw new ApiError(
        statusFromError(body.error),
        body.error.message,
        Object.keys(data).length > 0 ? data : undefined,
      );
    }
    recordRpc({
      method,
      params,
      durationMs: performance.now() - startedAt,
      ok: true,
    });
    return body.result as T;
  } catch (error) {
    recordRpc({
      method,
      params,
      durationMs: performance.now() - startedAt,
      ok: false,
      error: errorMessage(error),
    });
    throw error;
  }
}

export function getWebConfig() {
  return rpc<InitializeResult>("initialize", {
    protocolVersion: "2026-08-02",
    clientInfo: { name: "loophub-web" },
  }).then((result) => result.webConfig);
}

/** Poll persisted LoopHub events by id cursor. */
export function listEvents(
  input: {
    since?: number;
    repo?: string;
    labels?: string[];
    types?: string[];
    runId?: number;
    order?: "asc" | "desc";
    limit?: number;
  } = {},
) {
  return rpc<LoopEvent[]>("events/list", clean(input));
}

const full = (owner: string, repo: string) => `${owner}/${repo}`;

// Strip undefined values so they don't reach the wire (additionalProperties: false schemas).
function clean(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

// --- repos ---
export function listRepos(archived: "false" | "true" | "all" = "false") {
  const map = { false: "active", true: "archived", all: "all" } as const;
  return rpc<Repo[]>("repos/list", { archived: map[archived] });
}

export function createRepo(
  path: string,
  name: string,
  sessionId: string = getSessionId(),
) {
  return rpc<Repo>("repos/create", { path, name, session_id: sessionId });
}

export function getRepo(owner: string, repo: string) {
  return rpc<Repo>("repos/get", { name: full(owner, repo) });
}

export function setRepoArchived(
  owner: string,
  repo: string,
  archived: boolean,
  sessionId: string = getSessionId(),
) {
  return rpc<Repo>("repos/setArchived", {
    name: full(owner, repo),
    archived,
    session_id: sessionId,
  });
}

export function setRepoFavorite(
  owner: string,
  repo: string,
  favorite: boolean,
  sessionId: string = getSessionId(),
) {
  return rpc<Repo>("repos/setFavorite", {
    name: full(owner, repo),
    favorite,
    session_id: sessionId,
  });
}

// #485: rename the repo's owner/name (full_name). Returns the repo under its new name.
export function renameRepo(
  owner: string,
  repo: string,
  newName: string,
  sessionId: string = getSessionId(),
) {
  return rpc<Repo>("repos/rename", {
    name: full(owner, repo),
    new_name: newName,
    session_id: sessionId,
  });
}

// #1115: change the repo's base branch (default_branch) via the existing repos/update RPC.
export function setRepoDefaultBranch(
  owner: string,
  repo: string,
  defaultBranch: string,
  sessionId: string = getSessionId(),
) {
  return rpc<Repo>("repos/update", {
    name: full(owner, repo),
    default_branch: defaultBranch,
    session_id: sessionId,
  });
}

// #406: resolved merge-mode view (setting + effective + GitHub-remote presence) for the settings UI.
export function getRepoMergeMode(owner: string, repo: string) {
  return rpc<RepoMergeMode>("repos/mergeMode", { name: full(owner, repo) });
}

// #406: pin the repo's PR write action ('merge' | 'github_pr') or 'auto' to clear it.
export function setRepoMergeMode(
  owner: string,
  repo: string,
  mode: "merge" | "github_pr" | "auto",
  sessionId: string = getSessionId(),
) {
  return rpc<Repo>("repos/setMergeMode", {
    name: full(owner, repo),
    mode,
    session_id: sessionId,
  });
}

// #71: how the repo's checkout stands against origin, for the repo-top sidebar. Local refs only —
// this call does not contact origin.
export function getRepoOriginSync(owner: string, repo: string) {
  return rpc<RepoOriginSync>("repos/originSync", { name: full(owner, repo) });
}

// #71: fast-forward the repo's checkout from origin, answering with the refreshed sync state.
export function pullRepoFromOrigin(owner: string, repo: string) {
  return rpc<RepoOriginSync>("repos/pullFromOrigin", {
    name: full(owner, repo),
  });
}

// #71: refresh the repo's remote-tracking refs from origin (git fetch origin), answering with the
// refreshed sync state. Unlike pull, this never moves the checkout's branch.
export function fetchRepoFromOrigin(owner: string, repo: string) {
  return rpc<RepoOriginSync>("repos/fetchFromOrigin", {
    name: full(owner, repo),
  });
}

// #1532: resolved Coding agent view (raw override + effective config) for the settings UI.
export function getRepoAgentConfig(owner: string, repo: string) {
  return rpc<RepoAgentConfig>("repos/agentConfig", { name: full(owner, repo) });
}

// #1532: set the repo's Coding agent override — the toggle plus runtime/model/effort. When
// `override` is false the run falls back to the application defaults.
export function setRepoAgentConfig(
  owner: string,
  repo: string,
  input: {
    override: boolean;
    runtime?: CodingAgent | null;
    model?: string | null;
    effort?: string | null;
  },
  sessionId: string = getSessionId(),
) {
  return rpc<RepoAgentConfig>("repos/setAgentConfig", {
    name: full(owner, repo),
    override: input.override,
    runtime: input.runtime ?? undefined,
    model: input.model ?? undefined,
    effort: input.effort ?? undefined,
    session_id: sessionId,
  });
}

// #2422: per-repo additional text for the Create PR on GitHub agent prompt.
export function getRepoGithubPrExportExtraPrompt(owner: string, repo: string) {
  return rpc<RepoGithubPrExportExtraPrompt>("repos/githubPrExportExtraPrompt", {
    name: full(owner, repo),
  });
}

// #2422: set or clear the repo's additional Create PR on GitHub prompt. Empty string or null clears.
export function setRepoGithubPrExportExtraPrompt(
  owner: string,
  repo: string,
  extraPrompt: string | null,
  sessionId: string = getSessionId(),
) {
  return rpc<RepoGithubPrExportExtraPrompt>(
    "repos/setGithubPrExportExtraPrompt",
    {
      name: full(owner, repo),
      extra_prompt: extraPrompt,
      session_id: sessionId,
    },
  );
}

export interface WorkflowInput {
  name: string;
  repo?: string;
  description?: string;
  execute_prompt?: string;
  verify_prompt?: string;
}

type WorkflowUpdatePatch = Omit<Partial<WorkflowInput>, "name"> & {
  new_name?: string;
};

export function listWorkflows(
  input: { repo?: string; applicable_to_repo?: string } = {},
) {
  return rpc<Workflow[]>("workflows/list", clean(input));
}

export function getWorkerStatus() {
  return rpc<WorkerCompatibility>("worker/status", {});
}

export function getWorkflowContracts() {
  return rpc<WorkflowContracts>("workflows/contracts", {});
}

export function createWorkflow(
  input: WorkflowInput,
  sessionId: string = getSessionId(),
) {
  return rpc<Workflow>("workflows/create", {
    ...clean({ ...input }),
    session_id: sessionId,
  });
}

export function updateWorkflow(
  id: number,
  patch: WorkflowUpdatePatch,
  sessionId: string = getSessionId(),
) {
  const { name: _ignoredName, ...wirePatch } = patch as Partial<WorkflowInput> &
    WorkflowUpdatePatch;
  return rpc<Workflow>("workflows/update", {
    id,
    ...clean({ ...wirePatch }),
    session_id: sessionId,
  });
}

export function deleteWorkflow(id: number, sessionId: string = getSessionId()) {
  return rpc<{ ok: true }>("workflows/delete", {
    id,
    session_id: sessionId,
  });
}

export function archiveWorkflow(
  id: number,
  sessionId: string = getSessionId(),
) {
  return rpc<Workflow>("workflows/archive", {
    id,
    session_id: sessionId,
  });
}

// Workflow run display state for issue / PR detail (#1008). Returns null when the issue / PR has no run.
export function getWorkflowRunStateForIssue(repo: string, number: number) {
  return rpc<WorkflowRunState | null>("workflowRuns/stateForIssue", {
    repo,
    number,
  });
}

export function getWorkflowRunStateForPull(repo: string, number: number) {
  return rpc<WorkflowRunState | null>("workflowRuns/stateForPull", {
    repo,
    number,
  });
}

/** Persisted lifecycle events for one Workflow run, fetched only when its history dialog opens. */
export function getWorkflowRunHistory(repo: string, run: number) {
  return rpc<WorkflowRunHistoryEvent[]>("workflowRuns/history", { repo, run });
}

/** Persisted Workflow participants and their current per-session costs. */
export function getWorkflowRunAgentCosts(repo: string, run: number) {
  return rpc<WorkflowRunAgentCost[]>("workflowRuns/agentCosts", { repo, run });
}

/** Core-calculated total for the persisted Workflow participants. */
export function getWorkflowRunTotalCost(repo: string, run: number) {
  return rpc<WorkflowRunTotalCost>("workflowRuns/totalCost", { repo, run });
}

/** Raise a cost-held run's budget by its persisted increment (#1828). */
export function increaseWorkflowRunCostLimit(
  repo: string,
  run: number,
  expectedLimitUsd: number,
  sessionId: string = getSessionId(),
) {
  return rpc<{
    run: number;
    increment_usd: number;
    previous_limit_usd: number;
    current_limit_usd: number;
  }>("workflowRuns/increaseCostLimit", {
    repo,
    run,
    expected_limit_usd: expectedLimitUsd,
    session_id: sessionId,
  });
}

/** Raise a rework-held run's limit by its current limit. */
export function increaseWorkflowRunReworkLimit(
  repo: string,
  run: number,
  expectedLimit: number,
  sessionId: string = getSessionId(),
) {
  return rpc<{
    run: number;
    previous_limit: number;
    current_limit: number;
  }>("workflowRuns/increaseReworkLimit", {
    repo,
    run,
    expected_limit: expectedLimit,
    session_id: sessionId,
  });
}

// --- global settings ---
// Instance-level settings (#474), as opposed to the per-repo settings above.
export function getSettings() {
  return rpc<GlobalSettings>("settings/get");
}

export interface UpdateSettingsInput {
  agent?: CodingAgent;
  model?: string;
  effort?: string;
  codingAgent?: CodingAgent;
  devCostLimitUsd?: number;
  theme?: Theme;
  workflowContractLanguage?: GlobalSettings["workflowContractLanguage"];
}

export function updateSettings(
  input: UpdateSettingsInput,
  sessionId: string = getSessionId(),
) {
  return rpc<GlobalSettings>("settings/update", {
    ...input,
    session_id: sessionId,
  });
}

// --- stats ---
// Database statistics for the /stats page (#587).
export function getStats() {
  return rpc<Stats>("stats/get");
}

// --- agent sessions ---
// Agent session inventory for the /sessions page.
export function getAgentSessions() {
  return rpc<AgentSession[]>("sessions/list");
}

// --- notifications ---
export function listNotifications(
  input: { limit?: number; unreadOnly?: boolean } = {},
) {
  return rpc<Notification[]>("notifications/list", clean(input));
}

export function unreadNotificationCount() {
  return rpc<{ count: number }>("notifications/unreadCount");
}

export function readNotification(
  id: number,
  sessionId: string = getSessionId(),
) {
  return rpc<Notification>("notifications/read", { id, session_id: sessionId });
}

export function readAllNotifications(sessionId: string = getSessionId()) {
  return rpc<{ count: number }>("notifications/readAll", {
    session_id: sessionId,
  });
}

// --- terminal launch ---
export function launchTerminalWorkflow(input: {
  // Optional: the global "workflow-create" (New workflow) launch has no repo (#1889). Every other
  // workflow requires it, enforced by the terminal service.
  repo?: string;
  label?: string;
  workflow?:
    | "issue-create"
    | "workflow-create"
    | "github-pr-export"
    | "workflow-run";
  issueNumber?: number;
  prNumber?: number;
  // Saved workflow id for the "workflow-run" launch (#1007).
  workflowId?: number;
  targetBranch?: string;
  prompt?: string;
  // One-shot runtime/model/effort overrides from the New issue dropdown (#1275/#1534).
  agent?: CodingAgent;
  model?: string;
  effort?: string;
}) {
  return rpc<TerminalLaunchResult>("terminal/launch", clean(input));
}

/** Running herdr sessions grouped by repo, for terminal-aware UI surfaces (#495). */
export function getHerdrSessions() {
  return rpc<HerdrSessions>("terminal/sessions");
}

/** Recent terminal output for one herdr agent, for terminal previews (#500). */
export function getHerdrAgentRead(input: {
  repo: string;
  target: string;
  lines?: number;
}) {
  return rpc<HerdrAgentRead>("terminal/agentRead", clean(input));
}

/** Close the pane a herdr agent is running in (#521). */
export function killHerdrAgent(input: { repo: string; paneId: string }) {
  return rpc<{ ok: true }>("terminal/killAgent", input);
}

/** Switch herdr's focus to a running agent's pane — the issue-list Herdr badge (#579). */
export function focusHerdrAgent(input: { repo: string; paneId: string }) {
  return rpc<{ ok: true }>("terminal/focusAgent", input);
}

/** Send one literal user input to the live Herdr agent mapped to a PR worktree. */
export function sendHerdrAgentInput(input: {
  repo: string;
  pull: number;
  paneId: string;
  text: string;
}) {
  return rpc<{ ok: true }>("terminal/sendAgentInput", input);
}

// --- issues ---
export function listIssues(owner: string, repo: string, query = "") {
  const sp = new URLSearchParams(query);
  const labels = sp.get("labels");
  return rpc<Issue[]>(
    "issues/list",
    clean({
      repo: full(owner, repo),
      state: sp.get("state") ?? undefined,
      kind: sp.get("kind") ?? undefined,
      labels: labels ? labels.split(",").filter(Boolean) : undefined,
      workspace: sp.get("workspace") ?? undefined,
      lookahead: sp.get("lookahead") === "true" || undefined,
      perPage: sp.get("per_page") ? Number(sp.get("per_page")) : undefined,
      page: sp.get("page") ? Number(sp.get("page")) : undefined,
      sort: sp.get("sort") ?? undefined,
    }),
  );
}

export function getIssueListPage(
  owner: string,
  repo: string,
  query = "",
  options: {
    includeLabels?: boolean;
  } = {},
) {
  const sp = new URLSearchParams(query);
  const labels = sp.get("labels");
  return rpc<IssueListPage>(
    "pageData/issueList",
    clean({
      repo: full(owner, repo),
      state: sp.get("state") ?? undefined,
      labels: labels ? labels.split(",").filter(Boolean) : undefined,
      workspace: sp.get("workspace") ?? undefined,
      lookahead: sp.get("lookahead") === "true" || undefined,
      perPage: sp.get("per_page") ? Number(sp.get("per_page")) : undefined,
      page: sp.get("page") ? Number(sp.get("page")) : undefined,
      includeLabels: options.includeLabels || undefined,
    }),
  );
}

export function searchIssuesAndPulls(
  owner: string,
  repo: string,
  query: string,
) {
  return rpc<SearchResult[]>("search/query", {
    repo: full(owner, repo),
    query,
  });
}

export function listWorkspaces(owner: string, repo: string) {
  return rpc<Workspace[]>("workspaces/list", { repo: full(owner, repo) });
}

export function listArchivedWorkspaces(owner: string, repo: string) {
  return rpc<Workspace[]>("workspaces/listArchived", {
    repo: full(owner, repo),
  });
}

export function listSettingsWorkspaces(owner: string, repo: string) {
  return rpc<Workspace[]>("workspaces/listForSettings", {
    repo: full(owner, repo),
  });
}

export function listArchivedSettingsWorkspaces(owner: string, repo: string) {
  return rpc<Workspace[]>("workspaces/listArchivedForSettings", {
    repo: full(owner, repo),
  });
}

export function createWorkspace(
  owner: string,
  repo: string,
  branch: string,
  sessionId: string = getSessionId(),
) {
  return rpc<Workspace>("workspaces/create", {
    repo: full(owner, repo),
    branch,
    session_id: sessionId,
  });
}

export function setWorkspaceArchived(
  owner: string,
  repo: string,
  branch: string,
  archived: boolean,
  sessionId: string = getSessionId(),
) {
  return rpc<Workspace>(
    archived ? "workspaces/archive" : "workspaces/unarchive",
    {
      repo: full(owner, repo),
      branch,
      session_id: sessionId,
    },
  );
}

export function listLabels(owner: string, repo: string) {
  return rpc<Label[]>("labels/list", { repo: full(owner, repo) });
}

export function getIssue(owner: string, repo: string, number: number) {
  return rpc<Issue>("issues/get", { repo: full(owner, repo), number });
}

export function listIssueRefKinds(
  targets: { repo: string; numbers: number[] }[],
) {
  return rpc<IssueRefKind[]>("issues/refKinds", { targets });
}

export function getIssueDetailPage(
  owner: string,
  repo: string,
  number: number,
) {
  return rpc<IssueDetailPage>("pageData/issueDetail", {
    repo: full(owner, repo),
    number,
  });
}

export function listAcceptanceCriteria(
  owner: string,
  repo: string,
  number: number,
) {
  return rpc<AcceptanceCriterionDetail[]>("issues/ac/list", {
    repo: full(owner, repo),
    number,
  });
}

export function addAcceptanceCriterion(
  owner: string,
  repo: string,
  number: number,
  text: string,
) {
  return rpc<AcceptanceCriterionDetail>("issues/ac/add", {
    repo: full(owner, repo),
    number,
    text,
  });
}

export function setAcceptanceCriterionEnabled(
  owner: string,
  repo: string,
  number: number,
  criterionId: string,
  enabled: boolean,
) {
  return rpc<AcceptanceCriterionDetail>("issues/ac/setEnabled", {
    repo: full(owner, repo),
    number,
    criterion_id: criterionId,
    enabled,
  });
}

export function createIssue(
  owner: string,
  repo: string,
  input: {
    title: string;
    body?: string;
    labels?: string[];
    target_branch?: string | null;
  },
  sessionId: string = getSessionId(),
) {
  return rpc<Issue>(
    "issues/create",
    clean({ repo: full(owner, repo), ...input, session_id: sessionId }),
  );
}

export function listIssueComments(owner: string, repo: string, number: number) {
  return rpc<IssueComment[]>("comments/list", {
    repo: full(owner, repo),
    number,
  });
}

export function postIssueComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
) {
  return rpc<IssueComment>("comments/create", {
    repo: full(owner, repo),
    number,
    body,
  });
}

export function setIssueCommentArchived(
  owner: string,
  repo: string,
  number: number,
  commentId: number,
  archived: boolean,
) {
  return rpc<IssueComment>("comments/archive", {
    repo: full(owner, repo),
    number,
    comment_id: commentId,
    archived,
  });
}

export function postPullComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
) {
  return rpc<IssueComment>("pullComments/create", {
    repo: full(owner, repo),
    number,
    body,
  });
}

export function reactToPullComment(
  owner: string,
  repo: string,
  number: number,
  commentId: number,
  emoji: string,
) {
  return rpc<IssueComment>("pullComments/react", {
    repo: full(owner, repo),
    number,
    comment_id: commentId,
    emoji,
  });
}

export function setPullCommentArchived(
  owner: string,
  repo: string,
  number: number,
  commentId: number,
  archived: boolean,
) {
  return rpc<IssueComment>("pullComments/archive", {
    repo: full(owner, repo),
    number,
    comment_id: commentId,
    archived,
  });
}

export function patchIssue(
  owner: string,
  repo: string,
  number: number,
  patch: {
    state?: "open" | "closed";
    title?: string;
    body?: string;
    labels?: string[];
    workspace?: string | null;
    target_branch?: string | null;
  },
  sessionId: string = getSessionId(),
) {
  return rpc<Issue>(
    "issues/update",
    clean({ repo: full(owner, repo), number, ...patch, session_id: sessionId }),
  );
}

// --- pulls ---
export function listPulls(owner: string, repo: string, query = "") {
  const sp = new URLSearchParams(query);
  const merged = sp.get("merged");
  return rpc<PullRequest[]>(
    "pulls/list",
    clean({
      repo: full(owner, repo),
      state: sp.get("state") ?? undefined,
      merged: merged === "only" || merged === "exclude" ? merged : undefined,
      head: sp.get("head") ?? undefined,
      base: sp.get("base") ?? undefined,
      perPage: sp.get("per_page") ? Number(sp.get("per_page")) : undefined,
      page: sp.get("page") ? Number(sp.get("page")) : undefined,
    }),
  );
}

export function getPull(owner: string, repo: string, number: number) {
  return rpc<PullRequest>("pulls/get", { repo: full(owner, repo), number });
}

// #2263: the PR's agent-cost totals alone, on their own query key — the usage counter ticks far
// more often than the git-backed PR/issue detail payloads that used to carry them.
export function getPullUsage(owner: string, repo: string, number: number) {
  return rpc<PullUsage>("pulls/usage", { repo: full(owner, repo), number });
}

export function getPullDetailPage(owner: string, repo: string, number: number) {
  return rpc<PullDetailPage>("pageData/pullDetail", {
    repo: full(owner, repo),
    number,
    // The page carries diff feedback, which is read as the caller (see listDiffFeedback).
    session_id: getSessionId(),
  });
}

export function patchPull(
  owner: string,
  repo: string,
  number: number,
  patch: { state?: "open" | "closed"; title?: string; body?: string },
  sessionId: string = getSessionId(),
) {
  return rpc<PullRequest>(
    "pulls/update",
    clean({ repo: full(owner, repo), number, ...patch, session_id: sessionId }),
  );
}

export function archivePull(
  owner: string,
  repo: string,
  number: number,
  sessionId: string = getSessionId(),
) {
  return rpc<{ ok: true }>("pulls/archive", {
    repo: full(owner, repo),
    number,
    session_id: sessionId,
  });
}

export function unarchivePull(
  owner: string,
  repo: string,
  number: number,
  sessionId: string = getSessionId(),
) {
  return rpc<{ ok: true }>("pulls/unarchive", {
    repo: full(owner, repo),
    number,
    session_id: sessionId,
  });
}

export function listPullFiles(owner: string, repo: string, number: number) {
  return rpc<PullFile[]>("pulls/files", { repo: full(owner, repo), number });
}

export function getPullDiff(
  owner: string,
  repo: string,
  number: number,
  path?: string,
  ignoreWhitespace = false,
) {
  return rpc<PullDiff>(
    "pulls/diff",
    clean({
      repo: full(owner, repo),
      number,
      path,
      ignore_whitespace: ignoreWhitespace || undefined,
    }),
  );
}

export function listDiffFeedback(
  owner: string,
  repo: string,
  number: number,
  scope: { path?: string; orphaned?: boolean } = {},
) {
  return rpc<DiffFeedbackList>(
    "diffFeedback/list",
    clean({
      repo: full(owner, repo),
      number,
      path: scope.path,
      orphaned: scope.orphaned,
      session_id: getSessionId(),
    }),
  );
}

export function createDiffFeedback(
  owner: string,
  repo: string,
  number: number,
  input: {
    base_sha: string;
    head_sha: string;
    path: string;
    side: "LEFT" | "RIGHT";
    start_line: number;
    end_line: number;
    body: string;
  },
) {
  return rpc<{ thread: DiffFeedbackThread; comment: DiffFeedbackMessage }>(
    "diffFeedback/create",
    {
      repo: full(owner, repo),
      number,
      ...input,
    },
  );
}

export function replyDiffFeedback(
  owner: string,
  repo: string,
  number: number,
  threadId: number,
  body: string,
) {
  return rpc<{ thread: DiffFeedbackThread; reply: DiffFeedbackMessage }>(
    "diffFeedback/reply",
    {
      repo: full(owner, repo),
      number,
      thread_id: threadId,
      body,
    },
  );
}

export function setDiffFeedbackArchived(
  owner: string,
  repo: string,
  number: number,
  threadId: number,
  archived: boolean,
) {
  return rpc<DiffFeedbackThread>("diffFeedback/archive", {
    repo: full(owner, repo),
    number,
    thread_id: threadId,
    archived,
  });
}

export function reactToDiffFeedback(
  owner: string,
  repo: string,
  number: number,
  messageId: number,
  emoji: string,
  sessionId: string = getSessionId(),
) {
  return rpc<DiffFeedbackMessage>("diffFeedback/react", {
    repo: full(owner, repo),
    number,
    message_id: messageId,
    emoji,
    session_id: sessionId,
  });
}

export function listCommitFiles(owner: string, repo: string, sha: string) {
  return rpc<PullFile[]>("repos/commitFiles", {
    repo: full(owner, repo),
    sha,
  });
}

export function getPullFileAtRef(
  owner: string,
  repo: string,
  number: number,
  path: string,
  side: "base" | "head",
) {
  return rpc<FileAtRef>("pulls/fileAtRef", {
    repo: full(owner, repo),
    number,
    path,
    side,
  });
}

export function listPullReviews(owner: string, repo: string, number: number) {
  return rpc<PullReview[]>("reviews/list", { repo: full(owner, repo), number });
}

export function listPullComments(owner: string, repo: string, number: number) {
  return rpc<PullLineComment[]>("reviews/listComments", {
    repo: full(owner, repo),
    number,
  });
}

/** Orchestrator<->subagent handoffs (#352) recorded against a PR, chronological. */
export function listPullHandoffs(owner: string, repo: string, number: number) {
  return rpc<Handoff[]>("handoffs/list", {
    repo: full(owner, repo),
    pr: number,
  });
}

/** Read-only debug dump for a PR: raw DB rows, git facts, reviews, comments, events. */
export function getPullDebug(owner: string, repo: string, number: number) {
  return rpc<Record<string, unknown>>("pulls/debug", {
    repo: full(owner, repo),
    number,
  });
}

export function mergePull(
  owner: string,
  repo: string,
  number: number,
  mergeMethod: "squash" | "merge" | "rebase" = "squash",
  sessionId: string = getSessionId(),
) {
  return rpc<{ merged: boolean; sha: string }>("pulls/merge", {
    repo: full(owner, repo),
    number,
    merge_method: mergeMethod,
    session_id: sessionId,
  });
}

export function markGithubMerged(
  owner: string,
  repo: string,
  number: number,
  sessionId: string = getSessionId(),
) {
  return rpc<{ merged: true; merged_at: string }>("pulls/markGithubMerged", {
    repo: full(owner, repo),
    number,
    session_id: sessionId,
  });
}

/** GitHub-side status (#850) of a PR's linked GitHub PR. 404s when the PR has no linked GitHub PR. */
export function getGithubPrStatus(owner: string, repo: string, number: number) {
  return rpc<GithubPrStatus>("pulls/githubStatus", {
    repo: full(owner, repo),
    number,
  });
}

/** Push the PR's head to its linked GitHub PR branch; `force` uses `--force-with-lease` (#1861). */
export function pushGithubPull(
  owner: string,
  repo: string,
  number: number,
  force = false,
  sessionId: string = getSessionId(),
) {
  return rpc<GithubPull>("pulls/pushGithubPull", {
    repo: full(owner, repo),
    number,
    force,
    session_id: sessionId,
  });
}

/** Drop the PR's GitHub PR link (#2384); the GitHub PR itself is left alone. */
export function unlinkGithubPull(
  owner: string,
  repo: string,
  number: number,
  sessionId: string = getSessionId(),
) {
  return rpc<{ unlinked: true; github_number: number }>(
    "pulls/unlinkGithubPull",
    {
      repo: full(owner, repo),
      number,
      session_id: sessionId,
    },
  );
}

// --- dashboard ---
export function getDashboardOverview() {
  return rpc<DashboardOverview>("dashboard/overview");
}
