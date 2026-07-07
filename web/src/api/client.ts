// JSON-RPC 2.0 client for the LoopHub lh-web server (single endpoint POST /rpc).
//
// The contract is language-neutral (see docs/rpc-contract.json); this module is written
// against it and never imports core types — the wire shapes live in ./types. Base URL is
// VITE_LOOPHUB_API_URL when set, otherwise same-origin ("") so requests go through the Vite
// dev proxy (vite.config.ts).

import { getSessionId } from "@/lib/session";
import type {
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
  Issue,
  IssueComment,
  IssueGroupWithMembers,
  Label,
  LoopEvent,
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
  Repo,
  RepoMergeMode,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskWithRuns,
  Stats,
  TerminalLaunchResult,
} from "./types";

/** Resolved server base. "" => same-origin (proxy). No trailing slash. */
export const API_BASE: string = (
  import.meta.env?.VITE_LOOPHUB_API_URL ?? ""
).replace(/\/$/, "");

export const RPC_URL = `${API_BASE}/rpc`;

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

/** Build the /events SSE URL (same-origin via proxy unless an API base is set). */
export function eventsUrl(query = ""): string {
  return `${API_BASE}/events${query ? `?${query}` : ""}`;
}

/** Poll persisted LoopHub events by id cursor. */
export function listEvents(
  input: {
    since?: number;
    repo?: string;
    labels?: string[];
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

// --- global settings ---
// Instance-level config.json settings (#474), as opposed to the per-repo settings above.
export function getSettings() {
  return rpc<GlobalSettings>("settings/get");
}

export function updateSettings(
  input: {
    agent?: CodingAgent;
    autoModeOnBuild?: boolean;
    model?: string;
    effort?: string;
    codingAgent?: CodingAgent;
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

// --- terminal launch ---
export function launchTerminalWorkflow(input: {
  repo: string;
  label?: string;
  workflow?: "issue-dev" | "issue-create" | "resume" | "github-pr-export";
  issueNumber?: number;
  prNumber?: number;
  session?: string;
  cwd?: string;
  // One-shot issue-dev (Build) overrides from the issue-detail dropdown (#637).
  agent?: CodingAgent;
  model?: string;
}) {
  return rpc<TerminalLaunchResult>("terminal/launch", clean(input));
}

/** Running herdr sessions grouped by repo, for the sidebar status section (#495). */
export function getHerdrSessions() {
  return rpc<HerdrSessions>("terminal/sessions");
}

/** Recent terminal output for one herdr agent, for the sidebar hover preview (#500). */
export function getHerdrAgentRead(input: {
  repo: string;
  target: string;
  lines?: number;
}) {
  return rpc<HerdrAgentRead>("terminal/agentRead", clean(input));
}

/** Close the pane a herdr agent is running in — the sidebar kill button (#521). */
export function killHerdrAgent(input: { repo: string; paneId: string }) {
  return rpc<{ ok: true }>("terminal/killAgent", input);
}

/** Switch herdr's focus to a running agent's pane — the issue-list Herdr badge (#579). */
export function focusHerdrAgent(input: { repo: string; paneId: string }) {
  return rpc<{ ok: true }>("terminal/focusAgent", input);
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
      perPage: sp.get("per_page") ? Number(sp.get("per_page")) : undefined,
      page: sp.get("page") ? Number(sp.get("page")) : undefined,
      sort: sp.get("sort") ?? undefined,
    }),
  );
}

export function listLabels(owner: string, repo: string) {
  return rpc<Label[]>("labels/list", { repo: full(owner, repo) });
}

export function getIssue(owner: string, repo: string, number: number) {
  return rpc<Issue>("issues/get", { repo: full(owner, repo), number });
}

/** Groups this issue belongs to, each with its ordered members (#314). */
export function listIssueGroupsForIssue(
  owner: string,
  repo: string,
  number: number,
) {
  return rpc<IssueGroupWithMembers[]>("issueGroups/forIssue", {
    repo: full(owner, repo),
    number,
  });
}

export function createIssue(
  owner: string,
  repo: string,
  input: { title: string; body?: string; labels?: string[] },
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
  },
  sessionId: string = getSessionId(),
) {
  return rpc<Issue>(
    "issues/update",
    clean({ repo: full(owner, repo), number, ...patch, session_id: sessionId }),
  );
}

export function addIssueLabels(
  owner: string,
  repo: string,
  number: number,
  labels: string[],
  sessionId: string = getSessionId(),
) {
  return rpc<{ name: string; color?: string }[]>("issues/addLabels", {
    repo: full(owner, repo),
    number,
    labels,
    session_id: sessionId,
  });
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

export function listPullFiles(owner: string, repo: string, number: number) {
  return rpc<PullFile[]>("pulls/files", { repo: full(owner, repo), number });
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

export function markGithubMerged(
  owner: string,
  repo: string,
  number: number,
  sessionId: string = getSessionId(),
) {
  return rpc<{ merged: boolean }>("pulls/markGithubMerged", {
    repo: full(owner, repo),
    number,
    session_id: sessionId,
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
