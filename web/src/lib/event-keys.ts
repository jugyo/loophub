// Maps LoopHub events (GET /events, /events/stream) to TanStack Query keys to
// invalidate. Centralized so the SSE hook stays dumb. event.type prefixes:
//   issue.*          -> issue / issues lists
//   pull_request.*   -> pull / pulls lists
//   agent_session.*  -> agent-sessions
// See ../../../API.md for the full event type list.

import type { LoopEvent } from "@/api/types";

/** Query keys used across the app. Components build keys via these factories. */
export const queryKeys = {
  repos: () => ["repos"] as const,
  repo: (full: string) => ["repo", full] as const,
  issues: (full: string) => ["issues", full] as const,
  issue: (full: string, number: number) => ["issue", full, number] as const,
  pulls: (full: string) => ["pulls", full] as const,
  pull: (full: string, number: number) => ["pull", full, number] as const,
  agentSessions: () => ["agent-sessions"] as const,
  events: () => ["events"] as const,
  dashboard: () => ["dashboard"] as const,
};

/**
 * Query keys (as arrays) to invalidate for a given event. Returns key prefixes
 * suitable for `queryClient.invalidateQueries({ queryKey })`.
 */
export function queryKeysForEvent(event: LoopEvent): readonly unknown[][] {
  const keys: unknown[][] = [];
  const { type, repo, payload } = event;
  const number = payload?.number;

  if (type.startsWith("issue.")) {
    if (repo) {
      keys.push([...queryKeys.issues(repo)]);
      if (typeof number === "number") {
        keys.push([...queryKeys.issue(repo, number)]);
      }
    } else {
      keys.push(["issues"]);
      keys.push(["issue"]);
    }
    keys.push([...queryKeys.dashboard()]); // cross-repo top page
  } else if (type.startsWith("pull_request.")) {
    if (repo) {
      keys.push([...queryKeys.pulls(repo)]);
      if (typeof number === "number") {
        keys.push([...queryKeys.pull(repo, number)]);
      }
    } else {
      keys.push(["pulls"]);
      keys.push(["pull"]);
    }
    keys.push([...queryKeys.dashboard()]); // cross-repo top page
  } else if (type === "dev.note") {
    // A dev note targets a PR (and its issue). Invalidate the PR detail — the dev-note
    // timeline is a sub-key of the pull key, so the prefix refetches it — plus the lists.
    const prNumber = payload?.pr_number;
    if (repo) {
      keys.push([...queryKeys.pulls(repo)]);
      if (typeof prNumber === "number") {
        keys.push([...queryKeys.pull(repo, prNumber)]);
      }
    } else {
      keys.push(["pulls"]);
      keys.push(["pull"]);
    }
    keys.push([...queryKeys.dashboard()]);
  } else if (type.startsWith("agent_session.")) {
    keys.push([...queryKeys.agentSessions()]);
  }

  // Repo-level metadata (assignment / status counts) and the activity feed can
  // shift on any event for the repo.
  if (repo) {
    keys.push([...queryKeys.repo(repo)]);
    keys.push([...queryKeys.events(), repo]);
  }

  return keys;
}
