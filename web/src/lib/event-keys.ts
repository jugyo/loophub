// Maps LoopHub events to TanStack Query keys to invalidate. Centralized so the
// event polling hook stays dumb. event.type prefixes:
//   issue.*          -> issue / issues lists
//   pull_request.*   -> pull / pulls lists
//   notification.*   -> notification stack list/count
//   repo.*           -> repos list (+ old-name keys on repo.renamed)
//   agent_session.*  -> agent-sessions
//   terminal.*       -> terminal sessions (herdr snapshot, worker-owned #1665)
// See ../../../API.md for the full event type list.

import type { LoopEvent } from "@/api/types";

/** Query keys used across the app. Components build keys via these factories. */
export const queryKeys = {
  repos: () => ["repos"] as const,
  repo: (full: string) => ["repo", full] as const,
  labels: (full: string) => ["labels", full] as const,
  issues: (full: string) => ["issues", full] as const,
  issue: (full: string, number: number) => ["issue", full, number] as const,
  workspaces: (full: string) => ["workspaces", full] as const,
  pulls: (full: string) => ["pulls", full] as const,
  pull: (full: string, number: number) => ["pull", full, number] as const,
  notifications: () => ["notifications"] as const,
  agentSessions: () => ["agent-sessions"] as const,
  terminalSessions: () => ["terminal", "sessions"] as const,
  events: () => ["events"] as const,
  dashboard: () => ["dashboard"] as const,
  scheduledTasks: (full: string) => ["scheduled-tasks", full] as const,
  scheduledTask: (full: string, id: number) =>
    ["scheduled-task", full, id] as const,
  workflows: () => ["workflows"] as const,
  workflowRunForIssue: (full: string, number: number) =>
    ["workflow-run", "issue", full, number] as const,
  workflowRunForPull: (full: string, number: number) =>
    ["workflow-run", "pull", full, number] as const,
  workflowRunHistory: (full: string, run: number) =>
    ["workflow-run", "history", full, run] as const,
};

/**
 * Query keys (as arrays) to invalidate for a given event. Returns key prefixes
 * suitable for `queryClient.invalidateQueries({ queryKey })`.
 */
export function queryKeysForEvent(event: LoopEvent): readonly unknown[][] {
  const keys: unknown[][] = [];
  const { type, repo, payload } = event;
  const number = payload?.number;
  if (isNotificationSourceEvent(event)) {
    keys.push([...queryKeys.notifications()]);
  }

  if (type.startsWith("issue.")) {
    if (repo) {
      keys.push([...queryKeys.issues(repo)]);
      keys.push([...queryKeys.labels(repo)]);
      if (typeof number === "number") {
        keys.push([...queryKeys.issue(repo, number)]);
      }
    } else {
      keys.push(["issues"]);
      keys.push(["labels"]);
      keys.push(["issue"]);
    }
    keys.push([...queryKeys.dashboard()]); // cross-repo top page
  } else if (type.startsWith("workspace.")) {
    if (repo) {
      keys.push([...queryKeys.workspaces(repo)]);
      keys.push([...queryKeys.issues(repo)]);
    } else {
      keys.push(["workspaces"]);
      keys.push(["issues"]);
    }
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
    // Issue rows embed their linked PR's live status (mergeable/conflict, working,
    // review state, diff totals) via issueListItemJSON, so a PR change must also
    // refresh the issue list and any open issue detail — otherwise the list keeps a
    // stale `conflict` after the PR's tree goes clean (e.g. a rebase moves the head
    // and fires pull_request.updated; the PR detail refetches clean but the list,
    // already mounted, stays on the old value). The event carries the PR number, not
    // the linked issue number, so invalidate the repo's issue keys by prefix (#324).
    if (repo) {
      keys.push([...queryKeys.issues(repo)]);
      keys.push(["issue", repo]); // prefix: all open issue details for the repo
    } else {
      keys.push(["issues"]);
      keys.push(["issue"]);
    }
    keys.push([...queryKeys.dashboard()]); // cross-repo top page
  } else if (type === "handoff.recorded") {
    // A handoff (#352) is filed against a PR (payload.number / pr_number) and/or a generic issue
    // (payload.issue_number). Its section is a sub-key of the pull (and, for an issue-only handoff,
    // the issue) key, so invalidating that prefix refetches the Handoffs list. An issue-only handoff
    // carries no PR number, so route its issue_number to the issue keys instead — the generic
    // mechanism is not PR-only (#352).
    const prNumber = payload?.pr_number ?? payload?.number;
    const issueNumber = payload?.issue_number;
    if (repo) {
      keys.push([...queryKeys.pulls(repo)]);
      if (typeof prNumber === "number") {
        keys.push([...queryKeys.pull(repo, prNumber)]);
      }
      if (typeof issueNumber === "number") {
        keys.push([...queryKeys.issue(repo, issueNumber)]);
      }
    } else {
      keys.push(["pulls"]);
      keys.push(["pull"]);
      keys.push(["issue"]);
    }
    keys.push([...queryKeys.dashboard()]);
  } else if (type.startsWith("scheduled_task.")) {
    // Scheduled task CRUD (#880) alters the repo's task list for every connected client, not just
    // the tab that made the change (whose mutation hook already invalidates onSuccess). The payload
    // carries the task id, but create/delete change the whole list, so invalidate the list by prefix
    // plus the specific task's detail when an id is present.
    const id = payload?.id;
    if (repo) {
      keys.push([...queryKeys.scheduledTasks(repo)]);
      if (typeof id === "number")
        keys.push([...queryKeys.scheduledTask(repo, id)]);
    } else {
      keys.push(["scheduled-tasks"]);
      keys.push(["scheduled-task"]);
    }
  } else if (
    type === "workflow.created" ||
    type === "workflow.updated" ||
    type === "workflow.deleted"
  ) {
    // workflow CRUD (#1006) is global (not repo-scoped) and alters the workflow list for every
    // connected client, not just the tab that made the change (whose mutation hook already
    // invalidates onSuccess). Match only definition CRUD events: repo workflow execution events use
    // the existing workflow.run_* namespace and must not invalidate this unrelated global list.
    keys.push([...queryKeys.workflows()]);
  } else if (
    type.startsWith("workflow_run.") ||
    type.startsWith("workflow_step.")
  ) {
    // A Workflow run's step / status / rework count is shown on issue and PR detail (#1008). These
    // lifecycle events (workflow_run.started/updated/turn_done, workflow_step.launched) all carry
    // both issue_number and pr_number in the payload, so refresh both detail views' run-state query.
    // Fall back to the whole prefix defensively when the repo or numbers are somehow absent.
    const issueNumber = payload?.issue_number;
    const prNumber = payload?.pr_number ?? payload?.number;
    const runId = payload?.id;
    if (repo) {
      if (typeof issueNumber === "number") {
        keys.push([...queryKeys.workflowRunForIssue(repo, issueNumber)]);
      }
      if (typeof prNumber === "number") {
        keys.push([...queryKeys.workflowRunForPull(repo, prNumber)]);
      }
      if (typeof runId === "number") {
        keys.push([...queryKeys.workflowRunHistory(repo, runId)]);
      }
      if (typeof issueNumber !== "number" && typeof prNumber !== "number") {
        keys.push(["workflow-run"]);
      }
    } else {
      keys.push(["workflow-run"]);
    }
    // #2147: issue rows also embed the run's rework count (issueListItemJSON -> linkedPullDetail),
    // so the two transitions that change it — request_rework increments, resume_after_human resets
    // it to zero — have to refresh the issue views the same way a PR change does above. Scoped to
    // those transitions rather than the whole namespace: the other lifecycle moves leave the count
    // as it was, and an issue-list refetch pays a git fan-out per row.
    if (
      payload?.transition === "request_rework" ||
      payload?.transition === "resume_after_human"
    ) {
      if (repo) {
        keys.push([...queryKeys.issues(repo)]);
        keys.push(["issue", repo]); // prefix: all open issue details for the repo
      } else {
        keys.push(["issues"]);
        keys.push(["issue"]);
      }
      keys.push([...queryKeys.dashboard()]);
    }
  } else if (type.startsWith("notification.")) {
    keys.push([...queryKeys.notifications()]);
  } else if (type === "settings.updated") {
    // Instance-level settings (#474) are global, not repo-scoped — refetch the settings view and
    // anything derived from it (e.g. the terminal launch backend) regardless of which repo/tab the
    // change came from.
    keys.push(["settings"]);
    keys.push(["terminal", "config"]);
  } else if (type.startsWith("repo.")) {
    // Repo metadata changes (archived/favorited/renamed/merge_mode, #485) alter the app-shell
    // list for every connected client, not just the tab that performed the mutation (whose
    // hook already invalidates onSuccess). repo.renamed additionally strands the old name's
    // repo-scoped caches — the event's `repo` field carries the NEW full_name — so invalidate
    // the old-name prefixes via payload.from; a client sitting on the old URL refetches and
    // surfaces the 404 instead of showing stale data under a dead route.
    keys.push([...queryKeys.repos()]);
    // Dashboard rows embed the repo's full_name and /r/<full_name> links, so any repo
    // metadata change (rename especially) must refresh the cross-repo top page too.
    keys.push([...queryKeys.dashboard()]);
    const from = payload?.from;
    if (typeof from === "string" && from) {
      keys.push([...queryKeys.repo(from)]);
      keys.push(["issues", from]);
      keys.push(["issue", from]);
      keys.push(["pulls", from]);
      keys.push(["pull", from]);
      keys.push([...queryKeys.events(), from]);
    }
  } else if (type.startsWith("terminal.")) {
    // The worker's herdr snapshot sweep (#1665) fires terminal.sessions_updated (global, no repo)
    // only when the displayed herdr session state changed. Invalidate the single shared
    // terminal/sessions query so every terminal-aware surface refetches the new snapshot — this
    // replaces the old per-tab 3s poll.
    keys.push([...queryKeys.terminalSessions()]);
  } else if (type.startsWith("agent_session.")) {
    keys.push([...queryKeys.agentSessions()]);
    // Some agent_session events target a specific PR or issue (for example linked/usage_updated);
    // their related_sessions list and usage summary live in that detail's query too.
    if (repo) {
      const prNumber = payload?.pr;
      const issueNumber = payload?.issue;
      if (typeof prNumber === "number")
        keys.push([...queryKeys.pull(repo, prNumber)]);
      if (typeof issueNumber === "number")
        keys.push([...queryKeys.issue(repo, issueNumber)]);
    }
  }

  // Repo-level metadata (assignment / status counts) and the activity feed can
  // shift on any event for the repo.
  if (repo) {
    keys.push([...queryKeys.repo(repo)]);
    keys.push([...queryKeys.events(), repo]);
  }

  return keys;
}

function isNotificationSourceEvent(event: LoopEvent): boolean {
  if (
    event.type === "pull_request.ready_for_review" ||
    event.type === "pull_request.github_merged" ||
    event.type === "dev.cost_stopped"
  ) {
    return true;
  }
  return false;
}
