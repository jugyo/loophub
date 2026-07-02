// JSON-RPC 2.0 client for the LoopHub lh-web server (single endpoint POST /rpc).
//
// The contract is language-neutral (see docs/rpc-contract.json); this module is written
// against it and never imports core types — the wire shapes live in ./types. Base URL is
// VITE_LOOPHUB_API_URL when set, otherwise same-origin ("") so requests go through the Vite
// dev proxy (vite.config.ts).

import { getSessionId } from "@/lib/session";
import type {
  CodingAgent,
  DashboardOverview,
  FileAtRef,
  GlobalSettings,
  Handoff,
  HerdrAgentRead,
  HerdrSessions,
  Issue,
  IssueComment,
  IssueGroupWithMembers,
  LoopEvent,
  PullFile,
  PullLineComment,
  PullRequest,
  PullReview,
  Repo,
  RepoMergeMode,
  ReviewNote,
  TerminalLaunchBackend,
  TerminalLaunchConfig,
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

// --- global settings ---
// Instance-level config.json settings (#474), as opposed to the per-repo settings above.
export function getSettings() {
  return rpc<GlobalSettings>("settings/get");
}

export function updateSettings(
  input: {
    terminalLaunchBackend?: TerminalLaunchBackend;
    autoModeOnBuild?: boolean;
    codingAgent?: CodingAgent;
  },
  sessionId: string = getSessionId(),
) {
  return rpc<GlobalSettings>("settings/update", {
    ...input,
    session_id: sessionId,
  });
}

// --- terminal launch ---
export function getTerminalLaunchConfig() {
  return rpc<TerminalLaunchConfig>("terminal/config");
}

export function launchTerminalWorkflow(input: {
  repo: string;
  label?: string;
  workflow?: "issue-dev" | "issue-create" | "resume" | "github-pr-export";
  issueNumber?: number;
  prNumber?: number;
  session?: string;
  cwd?: string;
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

/** Review notes (per-file diff descriptions) associated with a PR, across its commit ranges. */
export function listPullReviewNotes(
  owner: string,
  repo: string,
  number: number,
) {
  return rpc<ReviewNote[]>("reviewNotes/list", {
    repo: full(owner, repo),
    pr: number,
  });
}

/** Orchestrator<->subagent handoffs (#352) recorded against a PR, chronological. */
export function listPullHandoffs(owner: string, repo: string, number: number) {
  return rpc<Handoff[]>("handoffs/list", {
    repo: full(owner, repo),
    pr: number,
  });
}

/** Read-only debug dump for a PR: raw DB rows, git facts, reviews, comments, notes, events. */
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

// --- events ---
export function listEvents(query = "") {
  const sp = new URLSearchParams(query);
  const labels = sp.get("label");
  const order = sp.get("order");
  return rpc<LoopEvent[]>(
    "events/list",
    clean({
      since: sp.get("since") ? Number(sp.get("since")) : undefined,
      repo: sp.get("repo") ?? undefined,
      labels: labels ? labels.split(",").filter(Boolean) : undefined,
      order: order === "desc" ? "desc" : undefined,
      limit: sp.get("per_page") ? Number(sp.get("per_page")) : undefined,
    }),
  );
}
