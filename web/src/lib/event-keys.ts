// Maps LoopHub events to TanStack Query keys to invalidate. Centralized so the
// event polling hook stays dumb. event.type prefixes:
//   issue.*          -> issue / issues lists
//   pull_request.*   -> pull / pulls lists
//   notification.*   -> notification stack list/count
//   repo.*           -> repos list (+ old-name keys on repo.renamed)
//   agent_session.*  -> agent-sessions
//   terminal.*       -> terminal sessions (herdr snapshot, worker-owned #1665)
// See ../../../API.md for the full event type list.
//
// The Issue / PR / Workflow run / scheduled-task identifiers come off `event.subjects`, which core
// normalizes (core/event-subjects.ts) — this module picks keys and does not decide which payload
// key names which subject. Handoff and agent-session targets remain UI metadata, along with a
// renamed repo's old name, and are read through the shared object decoder.

import type { LoopEvent } from "@/api/types";
import { eventPayloadRecord } from "../../../core/event-subjects.ts";

/** Query keys used across the app. Components build keys via these factories. */
export const queryKeys = {
  repos: () => ["repos"] as const,
  repo: (full: string) => ["repo", full] as const,
  repoMergeMode: (full: string) => ["repo-merge-mode", full] as const,
  labels: (full: string) => ["labels", full] as const,
  issues: (full: string) => ["issues", full] as const,
  issue: (full: string, number: number) => ["issue", full, number] as const,
  issueComments: (full: string, number: number) =>
    ["issue-comments", full, number] as const,
  workspaces: (full: string) => ["workspaces", full] as const,
  pulls: (full: string) => ["pulls", full] as const,
  pull: (full: string, number: number) => ["pull", full, number] as const,
  // Top-level rather than a child of pull(full, n): the PR detail is serialized from live git,
  // while these totals come from the DB alone — so the high-frequency usage tick refreshes the
  // numbers without dragging the git-backed payload along (#2263).
  pullUsage: (full: string, number: number) =>
    ["pull-usage", full, number] as const,
  pullDebug: (full: string, number: number) =>
    ["pull-debug", full, number] as const,
  pullFiles: (full: string, number: number) =>
    ["pull-files", full, number] as const,
  pullReviews: (full: string, number: number) =>
    ["pull-reviews", full, number] as const,
  pullReviewComments: (full: string, number: number) =>
    ["pull-review-comments", full, number] as const,
  githubPrStatus: (full: string, number: number) =>
    ["github-pr-status", full, number] as const,
  notifications: () => ["notifications"] as const,
  agentSessions: () => ["agent-sessions"] as const,
  // Keep the 60s cost poll outside the agent-session event invalidation prefix.
  agentCostSummary: () => ["agent-cost-summary"] as const,
  // Top-level rather than a child of repo(full): every repo-scoped event invalidates that prefix,
  // but the coding-agent override only changes through repo.agent_config_changed.
  repoAgentConfig: (full: string) => ["repo-agent-config", full] as const,
  terminalSessions: () => ["terminal", "sessions"] as const,
  events: () => ["events"] as const,
  dashboard: () => ["dashboard"] as const,
  workflows: () => ["workflows"] as const,
  workerStatus: () => ["worker", "status"] as const,
  workflowRunForIssue: (full: string, number: number) =>
    ["workflow-run", "issue", full, number] as const,
  workflowRunForPull: (full: string, number: number) =>
    ["workflow-run", "pull", full, number] as const,
  workflowRunHistory: (full: string, run: number) =>
    ["workflow-run", "history", full, run] as const,
};

function numberedSubject(
  event: LoopEvent,
  kind: "issue" | "pull",
): number | null {
  const subject = event.subjects.find((candidate) => candidate.kind === kind);
  return subject && "number" in subject ? subject.number : null;
}

function identifiedSubject(
  event: LoopEvent,
  kind: "workflow_run" | "scheduled_task",
): number | null {
  const subject = event.subjects.find((candidate) => candidate.kind === kind);
  return subject && "id" in subject ? subject.id : null;
}

/**
 * Query keys (as arrays) to invalidate for a given event. Returns key prefixes
 * suitable for `queryClient.invalidateQueries({ queryKey })`.
 */
export function queryKeysForEvent(event: LoopEvent): readonly unknown[][] {
  const keys: unknown[][] = [];
  const { type, repo } = event;
  const payload = eventPayloadRecord(event.payload);
  const issueNumber = numberedSubject(event, "issue");
  const pullNumber = numberedSubject(event, "pull");
  const workflowRunId = identifiedSubject(event, "workflow_run");
  if (isNotificationSourceEvent(event)) {
    keys.push([...queryKeys.notifications()]);
  }

  if (type.startsWith("issue.")) {
    if (repo) {
      keys.push([...queryKeys.issues(repo)]);
      keys.push([...queryKeys.labels(repo)]);
      if (issueNumber !== null) {
        keys.push([...queryKeys.issue(repo, issueNumber)]);
        if (type === "issue.commented") {
          keys.push([...queryKeys.issueComments(repo, issueNumber)]);
        }
      } else {
        keys.push(["issue", repo]);
      }
      // A PR debug dump embeds its linked Issue row and matching issue.* event history. The event
      // does not carry the linked PR number, so invalidate the repo prefix; only a mounted debug
      // query refetches.
      keys.push(["pull-debug", repo]);
    } else {
      keys.push(["issues"]);
      keys.push(["labels"]);
      keys.push(["issue"]);
      keys.push(["pull-debug"]);
      if (type === "issue.commented") {
        keys.push(["issue-comments"]);
      }
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
  } else if (type.startsWith("pull_request.") || type === "dev.cost_stopped") {
    const gitGraphChanged =
      type === "pull_request.merged" ||
      (type === "pull_request.updated" &&
        typeof payload?.sha === "string" &&
        payload.sha.length > 0);
    if (repo) {
      keys.push([...queryKeys.pulls(repo)]);
      if (pullNumber !== null) {
        keys.push([...queryKeys.pull(repo, pullNumber)]);
        // The debug dump includes the PR row, git facts, reviews, comments, and its event history,
        // so every PR-scoped event changes at least the event-history portion while it is open.
        keys.push([...queryKeys.pullDebug(repo, pullNumber)]);
        if (gitGraphChanged) {
          keys.push([...queryKeys.pullFiles(repo, pullNumber)]);
        }
        if (type === "pull_request.commented") {
          keys.push([...queryKeys.issueComments(repo, pullNumber)]);
        }
        if (type === "pull_request.review_submitted") {
          keys.push([...queryKeys.pullReviews(repo, pullNumber)]);
          if (typeof payload?.comments === "number" && payload.comments > 0) {
            keys.push([...queryKeys.pullReviewComments(repo, pullNumber)]);
          }
        }
        if (
          type === "pull_request.github_pr_recorded" ||
          type === "pull_request.github_pr_pushed" ||
          type === "pull_request.github_feedback" ||
          type === "pull_request.github_merged"
        ) {
          keys.push([...queryKeys.githubPrStatus(repo, pullNumber)]);
        }
      } else {
        keys.push(["pull", repo]);
      }
      if (gitGraphChanged) {
        keys.push([...queryKeys.workspaces(repo)]);
      }
    } else {
      keys.push(["pulls"]);
      keys.push(["pull"]);
      keys.push(["pull-debug"]);
      if (gitGraphChanged) keys.push(["workspaces"]);
      if (gitGraphChanged) keys.push(["pull-files"]);
      if (type === "pull_request.commented") {
        keys.push(["issue-comments"]);
      }
      if (type === "pull_request.review_submitted") {
        keys.push(["pull-reviews"]);
        if (typeof payload?.comments === "number" && payload.comments > 0) {
          keys.push(["pull-review-comments"]);
        }
      }
      if (
        type === "pull_request.github_pr_recorded" ||
        type === "pull_request.github_pr_pushed" ||
        type === "pull_request.github_feedback" ||
        type === "pull_request.github_merged"
      ) {
        keys.push(["github-pr-status"]);
      }
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
    // A handoff (#352) is filed against a PR and/or a generic issue. Those links are UI metadata,
    // not domain event subjects. Its section is a sub-key of the pull (and, for an issue-only
    // handoff, the issue) key, so narrow the metadata and invalidate those prefixes.
    const handoffPullNumber = payload?.pr_number ?? payload?.number;
    const handoffIssueNumber = payload?.issue_number;
    if (repo) {
      keys.push([...queryKeys.pulls(repo)]);
      if (typeof handoffPullNumber === "number") {
        keys.push([...queryKeys.pull(repo, handoffPullNumber)]);
        keys.push([...queryKeys.pullDebug(repo, handoffPullNumber)]);
      }
      if (typeof handoffIssueNumber === "number") {
        keys.push([...queryKeys.issue(repo, handoffIssueNumber)]);
      }
    } else {
      keys.push(["pulls"]);
      keys.push(["pull"]);
      keys.push(["issue"]);
    }
    keys.push([...queryKeys.dashboard()]);
  } else if (
    type === "workflow.created" ||
    type === "workflow.updated" ||
    type === "workflow.archived" ||
    type === "workflow.deleted"
  ) {
    // Workflow definition changes (#1006) are global (not repo-scoped) and alter the workflow list for every
    // connected client, not just the tab that made the change (whose mutation hook already
    // invalidates onSuccess). Match only definition CRUD events: repo workflow execution events use
    // the existing workflow.run_* namespace and must not invalidate this unrelated global list.
    keys.push([...queryKeys.workflows()]);
  } else if (
    type.startsWith("workflow_run.") ||
    type.startsWith("workflow_step.")
  ) {
    // A Workflow run's step / status / rework count is shown on issue and PR detail (#1008). These
    // lifecycle events (workflow_run.started/updated/turn_done, workflow_step.launched) name the
    // run's issue and PR as well as the run itself, so refresh both detail views' run-state query.
    // Fall back to the whole prefix defensively when the repo or subjects are somehow absent.
    if (repo) {
      if (issueNumber !== null) {
        keys.push([...queryKeys.workflowRunForIssue(repo, issueNumber)]);
      }
      if (pullNumber !== null) {
        keys.push([...queryKeys.workflowRunForPull(repo, pullNumber)]);
        keys.push([...queryKeys.pullDebug(repo, pullNumber)]);
      }
      if (workflowRunId !== null) {
        keys.push([...queryKeys.workflowRunHistory(repo, workflowRunId)]);
      }
      if (issueNumber === null && pullNumber === null) {
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
    // Repo metadata changes alter both the app-shell list and repo-scoped views. Issue-list page
    // data includes default_branch for grouping, so refresh it for other connected tabs too.
    // repo.renamed additionally strands the old name's repo-scoped caches — the event's `repo`
    // field carries the NEW full_name — so invalidate the old-name prefixes via payload.from.
    keys.push([...queryKeys.repos()]);
    // The repo's own detail (repos/get) and the resolved merge mode under the same prefix change
    // here and nowhere else, so this is the only branch that invalidates them (#2263).
    if (repo) keys.push([...queryKeys.repo(repo)]);
    // Dashboard rows embed the repo's full_name and /r/<full_name> links, so any repo
    // metadata change (rename especially) must refresh the cross-repo top page too.
    keys.push([...queryKeys.dashboard()]);
    if (repo) keys.push([...queryKeys.issues(repo)]);
    if (type === "repo.agent_config_changed" && repo) {
      keys.push([...queryKeys.repoAgentConfig(repo)]);
    }
    if (type === "repo.merge_mode_changed" && repo) {
      keys.push([...queryKeys.repoMergeMode(repo)]);
    }
    if (repo && type !== "repo.agent_config_changed") {
      // repoJSON is part of every PR debug dump, so repo metadata events change all open debug
      // queries for that repository even though the regular pull detail is unaffected. Agent
      // config is stored separately and is not part of repoJSON or the PR-scoped event history.
      keys.push(["pull-debug", repo]);
    }
    const from = payload?.from;
    if (typeof from === "string" && from) {
      keys.push([...queryKeys.repo(from)]);
      keys.push(["issues", from]);
      keys.push(["issue", from]);
      keys.push(["pulls", from]);
      keys.push(["pull", from]);
      keys.push(["repo-merge-mode", from]);
      keys.push(["issue-comments", from]);
      keys.push(["pull-debug", from]);
      keys.push(["pull-files", from]);
      keys.push(["pull-reviews", from]);
      keys.push(["pull-review-comments", from]);
      keys.push(["github-pr-status", from]);
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
    // those links are UI metadata whose related_sessions list and usage summary live in that
    // detail's query too.
    if (repo) {
      const prNumber = payload?.pr;
      const issueNumber = payload?.issue;
      // #2263: a running agent's usage counter is the app's highest-frequency event, and the only
      // thing it changes on those details is the tokens/cost pair — which now has its own git-free
      // query. Refetching a git-backed detail every few seconds for two numbers is not worth it.
      const usageOnly = type === "agent_session.usage_updated";
      if (typeof prNumber === "number") {
        if (usageOnly) keys.push([...queryKeys.pullUsage(repo, prNumber)]);
        else keys.push([...queryKeys.pull(repo, prNumber)]);
        // The debug dump embeds the PR's sessions and their usage, and only exists while a human
        // holds the modal open, so it keeps following every agent_session event.
        keys.push([...queryKeys.pullDebug(repo, prNumber)]);
      }
      if (typeof issueNumber === "number" && !usageOnly)
        keys.push([...queryKeys.issue(repo, issueNumber)]);
    }
  }

  if (type === "dev.cost_stopped" && repo && pullNumber !== null) {
    // This PR-scoped event is part of the debug dump's event history but does not use the
    // pull_request.* namespace.
    keys.push([...queryKeys.pullDebug(repo, pullNumber)]);
  }

  // The activity feed can shift on any event for the repo. The repo itself (repos/get) is
  // deliberately not here: repoJSON carries no counts and no usage, so it only changes on repo.*
  // events, which invalidate it in their own branch above (#2263).
  if (repo) {
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
