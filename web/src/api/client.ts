// JSON-RPC 2.0 client for the LoopHub lh-web server (single endpoint POST /rpc).
//
// The contract is language-neutral (see docs/rpc-contract.json); this module is written
// against it and never imports core types — the wire shapes live in ./types. The SPA is
// always served same-origin by its own lh-web (issue #1669), so requests are same-origin
// ("" base); there is no separate-backend override.

import { getSessionId } from "@/lib/session";
import type {
  AgentCostSummary,
  AgentSession,
  CodingAgent,
  DashboardOverview,
  FileAtRef,
  GithubPrStatus,
  GithubPull,
  GlobalSettings,
  Handoff,
  HerdrAgentRead,
  HerdrSessions,
  InboxMessage,
  Issue,
  IssueComment,
  Label,
  LoopEvent,
  Notification,
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
  Repo,
  RepoAgentConfig,
  RepoMergeMode,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskWithRuns,
  SearchResult,
  Stats,
  TerminalLaunchResult,
  WebConfig,
  Workflow,
  WorkflowRunHistoryEvent,
  WorkflowRunState,
  WorkflowStepContracts,
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
  return body.result as T;
}

export function getWebConfig() {
  return rpc<InitializeResult>("initialize", {
    protocolVersion: "2026-07-11",
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

// --- scheduled tasks (#880) ---
export interface ScheduledTaskInput {
  title: string;
  prompt: string;
  agent: CodingAgent;
  times: string[];
  model?: string | null;
  effort?: string | null;
}

export function listScheduledTasks(owner: string, repo: string) {
  return rpc<ScheduledTask[]>("scheduledTasks/list", {
    repo: full(owner, repo),
  });
}

export function getScheduledTask(owner: string, repo: string, id: number) {
  return rpc<ScheduledTaskWithRuns>("scheduledTasks/get", {
    repo: full(owner, repo),
    id,
  });
}

export function createScheduledTask(
  owner: string,
  repo: string,
  input: ScheduledTaskInput,
  sessionId: string = getSessionId(),
) {
  return rpc<ScheduledTask>("scheduledTasks/create", {
    repo: full(owner, repo),
    ...clean({ ...input }),
    session_id: sessionId,
  });
}

export function updateScheduledTask(
  owner: string,
  repo: string,
  id: number,
  patch: Partial<ScheduledTaskInput>,
  sessionId: string = getSessionId(),
) {
  return rpc<ScheduledTask>("scheduledTasks/update", {
    repo: full(owner, repo),
    id,
    ...clean({ ...patch }),
    session_id: sessionId,
  });
}

export function deleteScheduledTask(
  owner: string,
  repo: string,
  id: number,
  sessionId: string = getSessionId(),
) {
  return rpc<{ ok: true }>("scheduledTasks/delete", {
    repo: full(owner, repo),
    id,
    session_id: sessionId,
  });
}

export function runScheduledTask(
  owner: string,
  repo: string,
  id: number,
  sessionId: string = getSessionId(),
) {
  return rpc<ScheduledTaskRun | null>("scheduledTasks/run", {
    repo: full(owner, repo),
    id,
    session_id: sessionId,
  });
}

export interface WorkflowInput {
  name: string;
  description?: string;
  execute_prompt?: string;
  verify_prompt?: string;
}

type WorkflowUpdatePatch = Omit<Partial<WorkflowInput>, "name"> & {
  new_name?: string;
};

export function listWorkflows() {
  return rpc<Workflow[]>("workflows/list", {});
}

export function getWorkflowContracts() {
  return rpc<WorkflowStepContracts>("workflows/contracts", {});
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
  name: string,
  patch: WorkflowUpdatePatch,
  sessionId: string = getSessionId(),
) {
  const { name: _ignoredName, ...wirePatch } = patch as Partial<WorkflowInput> &
    WorkflowUpdatePatch;
  return rpc<Workflow>("workflows/update", {
    name,
    ...clean({ ...wirePatch }),
    session_id: sessionId,
  });
}

export function deleteWorkflow(
  name: string,
  sessionId: string = getSessionId(),
) {
  return rpc<{ ok: true }>("workflows/delete", {
    name,
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

// --- global settings ---
// Instance-level settings (#474), as opposed to the per-repo settings above.
export function getSettings() {
  return rpc<GlobalSettings>("settings/get");
}

export function updateSettings(
  input: {
    agent?: CodingAgent;
    autoModeOnLaunch?: boolean;
    model?: string;
    effort?: string;
    codingAgent?: CodingAgent;
    devCostLimitUsd?: number;
    workflowContractLanguage?: GlobalSettings["workflowContractLanguage"];
  },
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

export function getAgentCostSummary() {
  return rpc<AgentCostSummary[]>("sessions/costSummary");
}

// --- inbox ---
export function listInboxMessages(
  input: { state?: InboxMessage["state"]; limit?: number } = {},
) {
  return rpc<InboxMessage[]>("inbox/list", clean(input));
}

export function getInboxMessage(id: number) {
  return rpc<InboxMessage>("inbox/get", { id });
}

export function readInboxMessage(
  id: number,
  sessionId: string = getSessionId(),
) {
  return rpc<InboxMessage>("inbox/read", { id, session_id: sessionId });
}

export function unreadInboxMessage(
  id: number,
  sessionId: string = getSessionId(),
) {
  return rpc<InboxMessage>("inbox/unread", { id, session_id: sessionId });
}

export function archiveInboxMessage(
  id: number,
  sessionId: string = getSessionId(),
) {
  return rpc<InboxMessage>("inbox/archive", { id, session_id: sessionId });
}

export function unarchiveInboxMessage(
  id: number,
  sessionId: string = getSessionId(),
) {
  return rpc<InboxMessage>("inbox/unarchive", { id, session_id: sessionId });
}

export function deleteInboxMessage(
  id: number,
  sessionId: string = getSessionId(),
) {
  return rpc<InboxMessage>("inbox/delete", { id, session_id: sessionId });
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
  repo: string;
  label?: string;
  workflow?:
    | "issue-create"
    | "scheduled-task-create"
    | "resume"
    | "github-pr-export"
    | "pr-crit"
    | "workflow-run";
  issueNumber?: number;
  prNumber?: number;
  // Saved workflow id for the "workflow-run" launch (#1007).
  workflowId?: number;
  session?: string;
  cwd?: string;
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
  sessionId: string = getSessionId(),
) {
  return rpc<IssueComment>("comments/create", {
    repo: full(owner, repo),
    number,
    body,
    session_id: sessionId,
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

export function deletePull(
  owner: string,
  repo: string,
  number: number,
  sessionId: string = getSessionId(),
) {
  return rpc<{ ok: true }>("pulls/delete", {
    repo: full(owner, repo),
    number,
    session_id: sessionId,
  });
}

export function listPullFiles(owner: string, repo: string, number: number) {
  return rpc<PullFile[]>("pulls/files", { repo: full(owner, repo), number });
}

export function listPullCommitFiles(
  owner: string,
  repo: string,
  number: number,
  sha: string,
) {
  return rpc<PullFile[]>("pulls/commitFiles", {
    repo: full(owner, repo),
    number,
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

/** GitHub-side status (#850) of a PR's linked GitHub PR. 404s when the PR has no linked GitHub PR. */
export function getGithubPrStatus(owner: string, repo: string, number: number) {
  return rpc<GithubPrStatus>("pulls/githubStatus", {
    repo: full(owner, repo),
    number,
  });
}

export function pushGithubPull(
  owner: string,
  repo: string,
  number: number,
  sessionId: string = getSessionId(),
) {
  return rpc<GithubPull>("pulls/pushGithubPull", {
    repo: full(owner, repo),
    number,
    session_id: sessionId,
  });
}

export function readyForReview(
  owner: string,
  repo: string,
  number: number,
  body?: string,
  sessionId: string = getSessionId(),
) {
  return rpc<PullRequest>(
    "pulls/readyForReview",
    clean({ repo: full(owner, repo), number, body, session_id: sessionId }),
  );
}

// --- dashboard ---
export function getDashboardOverview() {
  return rpc<DashboardOverview>("dashboard/overview");
}
