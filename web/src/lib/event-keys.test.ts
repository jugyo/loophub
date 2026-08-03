import { describe, expect, it } from "vitest";
import type { LoopEvent } from "@/api/types";
import { eventSubjects } from "../../../core/event-subjects.ts";
import { queryKeys, queryKeysForEvent } from "./event-keys";

// Events reach the web already normalized, so the fixture derives its subjects the same way
// formatEvent does rather than hand-writing one that could disagree with the server.
function ev(partial: Partial<LoopEvent>): LoopEvent {
  const event = {
    id: 1,
    type: "issue.opened",
    actor: "impl-bot",
    payload: {},
    created_at: "2026-06-17T00:00:00Z",
    ...partial,
  };
  return {
    ...event,
    subjects: partial.subjects ?? eventSubjects(event.type, event.payload),
  };
}

describe("queryKeysForEvent", () => {
  it("maps issue events to issues list + issue detail for a repo", () => {
    const keys = queryKeysForEvent(
      ev({ type: "issue.opened", repo: "me/proj", payload: { number: 12 } }),
    );
    expect(keys).toContainEqual(["issues", "me/proj"]);
    expect(keys).toContainEqual(["issue", "me/proj", 12]);
  });

  it("uses normalized subjects instead of payload identifiers", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "issue.updated",
        repo: "me/proj",
        payload: { number: 12 },
        subjects: [{ kind: "issue", number: 44 }],
      }),
    );
    expect(keys).toContainEqual(["issue", "me/proj", 44]);
    expect(keys).not.toContainEqual(["issue", "me/proj", 12]);
  });

  it("maps pull_request events to pulls list + pull detail", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "pull_request.merged",
        repo: "me/proj",
        payload: { number: 13 },
      }),
    );
    expect(keys).toContainEqual(["pulls", "me/proj"]);
    expect(keys).toContainEqual(["pull", "me/proj", 13]);
    expect(keys).toContainEqual(["workspaces", "me/proj"]);
  });

  it("maps a global terminal.sessions_updated event to the terminal sessions query (#1665)", () => {
    const keys = queryKeysForEvent(ev({ type: "terminal.sessions_updated" }));
    expect(keys).toContainEqual(["terminal", "sessions"]);
  });

  it("maps workspace events to the repo workspace list", () => {
    const keys = queryKeysForEvent(
      ev({ type: "workspace.archived", repo: "me/proj" }),
    );
    expect(keys).toContainEqual(["workspaces", "me/proj"]);
    expect(keys).toContainEqual(["issues", "me/proj"]);
  });

  it("also refreshes the repo's issue list + details for a pull_request event (#324)", () => {
    // Issue rows embed their linked PR's mergeable/conflict status, so a PR change
    // (e.g. a rebase that clears a conflict) must invalidate the issue views too —
    // otherwise the list keeps a stale `conflict` while the PR detail shows clean.
    const keys = queryKeysForEvent(
      ev({
        type: "pull_request.updated",
        repo: "me/proj",
        payload: { number: 13, sha: "abc123" },
      }),
    );
    expect(keys).toContainEqual(["issues", "me/proj"]);
    expect(keys).toContainEqual(["issue", "me/proj"]);
    expect(keys).toContainEqual(["workspaces", "me/proj"]);
  });

  it("falls back to broad issue keys for a repo-less pull_request event (#324)", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "pull_request.updated",
        repo: undefined,
        payload: { sha: "abc123" },
      }),
    );
    expect(keys).toContainEqual(["issues"]);
    expect(keys).toContainEqual(["issue"]);
    expect(keys).toContainEqual(["workspaces"]);
  });

  it("maps agent_session events to agent-sessions", () => {
    const keys = queryKeysForEvent(ev({ type: "agent_session.registered" }));
    expect(keys).toContainEqual(["agent-sessions"]);
  });

  it("leaves the repo agent config alone on ordinary repo-scoped events", () => {
    const keys = queryKeysForEvent(
      ev({ type: "issue.updated", repo: "me/proj", payload: { number: 12 } }),
    );
    expect(keys).not.toContainEqual(["repo-agent-config", "me/proj"]);
  });

  it("keeps low-frequency query keys outside their broad detail prefixes", () => {
    expect(queryKeys.repoMergeMode("me/proj")[0]).not.toBe("repo");
    expect(queryKeys.issueComments("me/proj", 12)[0]).not.toBe("issue");
    expect(queryKeys.pullDebug("me/proj", 13)[0]).not.toBe("pull");
    expect(queryKeys.pullFiles("me/proj", 13)[0]).not.toBe("pull");
    expect(queryKeys.pullReviews("me/proj", 13)[0]).not.toBe("pull");
    expect(queryKeys.pullReviewComments("me/proj", 13)[0]).not.toBe("pull");
    expect(queryKeys.githubPrStatus("me/proj", 13)[0]).not.toBe("pull");
  });

  it("refreshes merge mode only for its config event", () => {
    const ordinary = queryKeysForEvent(
      ev({ type: "issue.updated", repo: "me/proj", payload: { number: 12 } }),
    );
    expect(ordinary).not.toContainEqual(["repo-merge-mode", "me/proj"]);

    const changed = queryKeysForEvent(
      ev({ type: "repo.merge_mode_changed", repo: "me/proj" }),
    );
    expect(changed).toContainEqual(["repo-merge-mode", "me/proj"]);
  });

  it("refreshes pull files only when the git graph changes", () => {
    const metadataUpdated = queryKeysForEvent(
      ev({
        type: "pull_request.updated",
        repo: "me/proj",
        payload: { number: 13 },
      }),
    );
    expect(metadataUpdated).not.toContainEqual(["pull-files", "me/proj", 13]);

    const headUpdated = queryKeysForEvent(
      ev({
        type: "pull_request.updated",
        repo: "me/proj",
        payload: { number: 13, sha: "abc123" },
      }),
    );
    expect(headUpdated).toContainEqual(["pull-files", "me/proj", 13]);

    const merged = queryKeysForEvent(
      ev({
        type: "pull_request.merged",
        repo: "me/proj",
        payload: { number: 13 },
      }),
    );
    expect(merged).toContainEqual(["pull-files", "me/proj", 13]);
  });

  it("routes comment and review events to their independent queries", () => {
    const issueCommented = queryKeysForEvent(
      ev({
        type: "issue.commented",
        repo: "me/proj",
        payload: { number: 12 },
      }),
    );
    expect(issueCommented).toContainEqual(["issue-comments", "me/proj", 12]);

    const pullCommented = queryKeysForEvent(
      ev({
        type: "pull_request.commented",
        repo: "me/proj",
        payload: { number: 13 },
      }),
    );
    expect(pullCommented).toContainEqual(["issue-comments", "me/proj", 13]);
    expect(pullCommented).not.toContainEqual(["pull-reviews", "me/proj", 13]);

    const reviewed = queryKeysForEvent(
      ev({
        type: "pull_request.review_submitted",
        repo: "me/proj",
        payload: { number: 13, comments: 1 },
      }),
    );
    expect(reviewed).toContainEqual(["pull-reviews", "me/proj", 13]);
    expect(reviewed).toContainEqual(["pull-review-comments", "me/proj", 13]);

    const reviewedWithoutComments = queryKeysForEvent(
      ev({
        type: "pull_request.review_submitted",
        repo: "me/proj",
        payload: { number: 13, comments: 0 },
      }),
    );
    expect(reviewedWithoutComments).toContainEqual([
      "pull-reviews",
      "me/proj",
      13,
    ]);
    expect(reviewedWithoutComments).not.toContainEqual([
      "pull-review-comments",
      "me/proj",
      13,
    ]);
  });

  it("refreshes GitHub status only for GitHub-side status events", () => {
    const local = queryKeysForEvent(
      ev({
        type: "pull_request.review_submitted",
        repo: "me/proj",
        payload: { number: 13 },
      }),
    );
    expect(local).not.toContainEqual(["github-pr-status", "me/proj", 13]);

    const github = queryKeysForEvent(
      ev({
        type: "pull_request.github_feedback",
        repo: "me/proj",
        payload: { number: 13 },
      }),
    );
    expect(github).toContainEqual(["github-pr-status", "me/proj", 13]);
  });

  it("refreshes pull debug for dump-changing events without using the pull prefix", () => {
    const commented = queryKeysForEvent(
      ev({
        type: "pull_request.commented",
        repo: "me/proj",
        payload: { number: 13 },
      }),
    );
    expect(commented).toContainEqual(["pull-debug", "me/proj", 13]);

    const linkedIssueUpdated = queryKeysForEvent(
      ev({ type: "issue.updated", repo: "me/proj", payload: { number: 12 } }),
    );
    expect(linkedIssueUpdated).toContainEqual(["pull-debug", "me/proj"]);
  });

  it("maps repo.agent_config_changed to the repo agent config", () => {
    const keys = queryKeysForEvent(
      ev({ type: "repo.agent_config_changed", repo: "me/proj" }),
    );
    expect(keys).toContainEqual(["repo-agent-config", "me/proj"]);
    expect(keys).not.toContainEqual(["pull-debug", "me/proj"]);
  });

  it("leaves the cost summary alone on agent_session events", () => {
    const keys = queryKeysForEvent(ev({ type: "agent_session.updated" }));
    expect(keys).not.toContainEqual(["agent-cost-summary"]);
  });

  it("falls back to broad keys when repo is absent", () => {
    const keys = queryKeysForEvent(
      ev({ type: "issue.labeled", repo: undefined, payload: { number: 5 } }),
    );
    expect(keys).toContainEqual(["issues"]);
    expect(keys).toContainEqual(["issue"]);
  });

  // #2263: repoJSON carries no counts and no usage, so nothing under the repo prefix (the repo
  // detail, the resolved merge mode) can change on an issue / PR / session event. Invalidating it
  // for every repo-scoped event refetched the repo on each tick of a running agent's usage counter.
  it("leaves the repo key alone for events that are not repo.* (#2263)", () => {
    for (const event of [
      ev({ type: "issue.closed", repo: "me/proj", payload: { number: 1 } }),
      ev({
        type: "pull_request.updated",
        repo: "me/proj",
        payload: { number: 13 },
      }),
      ev({
        type: "agent_session.usage_updated",
        repo: "me/proj",
        payload: { session_id: "s", pr: 7 },
      }),
    ]) {
      expect(queryKeysForEvent(event)).not.toContainEqual(["repo", "me/proj"]);
    }
  });

  it("invalidates the repo key on repo.* events, which is where it changes (#2263)", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "repo.merge_mode_changed",
        repo: "me/proj",
        payload: { full_name: "me/proj", merge_mode: "github_pr" },
      }),
    );
    // The resolved merge mode lives under this prefix, so the settings toggle must refetch it.
    expect(keys).toContainEqual(["repo", "me/proj"]);
  });

  it("invalidates the repo activity feed for repo-scoped events", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "pull_request.opened",
        repo: "me/proj",
        payload: { number: 2 },
      }),
    );
    expect(keys).toContainEqual(["events", "me/proj"]);
  });

  it("omits issue/pull keys for unrelated event types", () => {
    const keys = queryKeysForEvent(ev({ type: "agent_session.updated" }));
    expect(keys).not.toContainEqual(["issues"]);
    expect(keys).not.toContainEqual(["pulls"]);
  });

  it("maps settings.updated to the settings view and terminal config, with no repo key (#474)", () => {
    const keys = queryKeysForEvent(
      ev({ type: "settings.updated", repo: undefined, payload: {} }),
    );
    expect(keys).toContainEqual(["settings"]);
    expect(keys).toContainEqual(["terminal", "config"]);
  });

  it("maps workflow events to the global workflows list, with no repo key (#1006)", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "workflow.created",
        repo: undefined,
        payload: { id: 3, name: "standard" },
      }),
    );
    expect(keys).toContainEqual(["workflows"]);
  });

  it("maps workflow archive events to the global workflows list", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "workflow.archived",
        repo: undefined,
        payload: { id: 3, name: "standard" },
      }),
    );
    expect(keys).toContainEqual(["workflows"]);
  });

  it("does not treat repo workflow execution events as workflow definition changes", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "workflow.run_started",
        repo: "me/proj",
        payload: { event_id: 1 },
      }),
    );
    expect(keys).not.toContainEqual(["workflows"]);
  });

  it("routes agent_session.linked to the target PR/issue detail (#298)", () => {
    const prKeys = queryKeysForEvent(
      ev({
        type: "agent_session.linked",
        repo: "me/proj",
        payload: { session_id: "s", pr: 7 },
      }),
    );
    expect(prKeys).toContainEqual(["agent-sessions"]);
    expect(prKeys).toContainEqual(["pull", "me/proj", 7]);

    const issueKeys = queryKeysForEvent(
      ev({
        type: "agent_session.linked",
        repo: "me/proj",
        payload: { session_id: "s", issue: 4 },
      }),
    );
    expect(issueKeys).toContainEqual(["issue", "me/proj", 4]);
  });

  // #2263: usage ticks are the app's highest-frequency event. The only thing they change on the
  // PR / issue details is the tokens/cost pair, which now has its own DB-only query — so they must
  // not drag along the details, whose serializers read live git.
  it("routes agent_session.usage_updated to the git-free usage query only (#2263)", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "agent_session.usage_updated",
        repo: "me/proj",
        payload: { session_id: "s", pr: 7, issue: 4 },
      }),
    );
    expect(keys).toContainEqual(["agent-sessions"]);
    expect(keys).toContainEqual(["pull-usage", "me/proj", 7]);
    expect(keys).not.toContainEqual(["pull", "me/proj", 7]);
    expect(keys).not.toContainEqual(["issue", "me/proj", 4]);
  });

  // The other agent_session events change the details themselves (their related_sessions list), so
  // they keep invalidating them.
  it("keeps routing other agent_session events to the target detail (#2263)", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "agent_session.linked",
        repo: "me/proj",
        payload: { session_id: "s", pr: 7 },
      }),
    );
    expect(keys).toContainEqual(["pull", "me/proj", 7]);
    expect(keys).not.toContainEqual(["pull-usage", "me/proj", 7]);
  });

  it("maps repo.* events to repo metadata consumers", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "repo.archived",
        repo: "me/proj",
        payload: { full_name: "me/proj" },
      }),
    );
    expect(keys).toContainEqual(["repos"]);
    expect(keys).toContainEqual(["repo", "me/proj"]);
    expect(keys).toContainEqual(["issues", "me/proj"]);
  });

  it("invalidates the old name's keys for repo.renamed via payload.from (#485)", () => {
    // event.repo carries the NEW full_name; the stale caches live under the old one.
    const keys = queryKeysForEvent(
      ev({
        type: "repo.renamed",
        repo: "acme/renamed",
        payload: { full_name: "acme/renamed", from: "me/proj" },
      }),
    );
    expect(keys).toContainEqual(["repos"]);
    expect(keys).toContainEqual(["repo", "me/proj"]);
    expect(keys).toContainEqual(["issues", "me/proj"]);
    expect(keys).toContainEqual(["pulls", "me/proj"]);
    expect(keys).toContainEqual(["events", "me/proj"]);
    // Dashboard rows embed full_name + links, so the top page must refresh too.
    expect(keys).toContainEqual(["dashboard"]);
    // The new name's repo key comes from the repo.* branch itself (#2263).
    expect(keys).toContainEqual(["repo", "acme/renamed"]);
  });

  it("refreshes notifications for source events that materialize topbar alerts", () => {
    expect(
      queryKeysForEvent(
        ev({
          type: "pull_request.ready_for_review",
          repo: "me/proj",
          payload: { number: 12 },
        }),
      ),
    ).toContainEqual(["notifications"]);
    expect(
      queryKeysForEvent(
        ev({
          type: "dev.cost_stopped",
          repo: "me/proj",
          payload: { number: 12 },
        }),
      ),
    ).toContainEqual(["notifications"]);
    expect(
      queryKeysForEvent(
        ev({
          type: "pull_request.github_merged",
          repo: "me/proj",
          payload: { number: 12 },
        }),
      ),
    ).toContainEqual(["notifications"]);
    expect(
      queryKeysForEvent(
        ev({
          type: "pull_request.review_submitted",
          repo: "me/proj",
          payload: { number: 12, state: "REQUEST_CHANGES" },
        }),
      ),
    ).not.toContainEqual(["notifications"]);
  });

  it("maps dev.cost_stopped to the affected pull list and detail", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "dev.cost_stopped",
        repo: "me/proj",
        payload: { number: 12 },
      }),
    );
    expect(keys).toContainEqual(["pulls", "me/proj"]);
    expect(keys).toContainEqual(["pull", "me/proj", 12]);
  });

  it("routes a handoff to the PR it is filed against, and an issue-only one to the issue (#352)", () => {
    const prKeys = queryKeysForEvent(
      ev({
        type: "handoff.recorded",
        repo: "me/proj",
        payload: { pr_number: 13, issue_number: 4 },
      }),
    );
    expect(prKeys).toContainEqual(["pull", "me/proj", 13]);
    expect(prKeys).toContainEqual(["issue", "me/proj", 4]);

    const issueOnlyKeys = queryKeysForEvent(
      ev({
        type: "handoff.recorded",
        repo: "me/proj",
        payload: { issue_number: 4 },
      }),
    );
    expect(issueOnlyKeys).toContainEqual(["issue", "me/proj", 4]);
    expect(issueOnlyKeys).toContainEqual(["pulls", "me/proj"]);
  });

  it("maps workflow run lifecycle events to both detail views and the run history (#1008)", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "workflow_run.updated",
        repo: "me/proj",
        payload: { id: 9, issue_number: 4, pr_number: 13 },
      }),
    );
    expect(keys).toContainEqual(["workflow-run", "issue", "me/proj", 4]);
    expect(keys).toContainEqual(["workflow-run", "pull", "me/proj", 13]);
    expect(keys).toContainEqual(["workflow-run", "history", "me/proj", 9]);
  });

  it("falls back to the whole workflow-run prefix when the event names neither issue nor PR", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "workflow_step.launched",
        repo: "me/proj",
        payload: { id: 9 },
      }),
    );
    expect(keys).toContainEqual(["workflow-run"]);
  });

  it.each([
    ["issue.updated", "null", null, ["issue", "me/proj"]],
    ["issue.updated", "an array", [1, 2], ["issue", "me/proj"]],
    ["issue.updated", "a primitive", 12, ["issue", "me/proj"]],
    ["issue.updated", "a legacy object", {}, ["issue", "me/proj"]],
    ["pull_request.updated", "null", null, ["pull", "me/proj"]],
    ["pull_request.updated", "an array", [1, 2], ["pull", "me/proj"]],
    ["pull_request.updated", "a primitive", 12, ["pull", "me/proj"]],
    ["pull_request.updated", "a legacy object", {}, ["pull", "me/proj"]],
  ])("falls back to the %s detail prefix when the payload is %s", (type, _label, payload, detailPrefix) => {
    const keys = queryKeysForEvent(ev({ type, repo: "me/proj", payload }));
    expect(keys).toContainEqual(detailPrefix);
  });

  it("invalidates nothing extra for a repo.renamed whose payload carries no old name", () => {
    const keys = queryKeysForEvent(
      ev({ type: "repo.renamed", repo: "acme/renamed", payload: null }),
    );
    expect(keys).toContainEqual(["repos"]);
    expect(keys).toContainEqual(["repo", "acme/renamed"]);
    expect(keys).not.toContainEqual(["repo", "me/proj"]);
  });

  // #2147: the issue list shows the run's rework count, so both transitions that change it must
  // refresh the list — and only those, since the list refetch costs a git fan-out per row.
  it("refreshes the issue views when a run's rework count changes (#2147)", () => {
    const reworked = queryKeysForEvent(
      ev({
        type: "workflow_run.updated",
        repo: "me/proj",
        payload: {
          id: 7,
          transition: "request_rework",
          issue_number: 12,
          pr_number: 13,
          rework_count: 3,
        },
      }),
    );
    expect(reworked).toContainEqual(["issues", "me/proj"]);
    expect(reworked).toContainEqual(["dashboard"]);

    // A human-instructed resume resets the count to zero, so a row left showing the old number
    // would read as "still circling" right after the run was released from its hold.
    const resumed = queryKeysForEvent(
      ev({
        type: "workflow_run.updated",
        repo: "me/proj",
        payload: {
          id: 7,
          transition: "resume_after_human",
          issue_number: 12,
          pr_number: 13,
          rework_count: 0,
        },
      }),
    );
    expect(resumed).toContainEqual(["issues", "me/proj"]);
    expect(resumed).toContainEqual(["dashboard"]);

    const otherTransition = queryKeysForEvent(
      ev({
        type: "workflow_run.updated",
        repo: "me/proj",
        payload: {
          id: 7,
          transition: "activate_step",
          issue_number: 12,
          pr_number: 13,
        },
      }),
    );
    expect(otherTransition).toContainEqual([
      "workflow-run",
      "pull",
      "me/proj",
      13,
    ]);
    expect(otherTransition).not.toContainEqual(["issues", "me/proj"]);
  });
});
