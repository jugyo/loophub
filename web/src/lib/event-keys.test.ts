import { describe, expect, it } from "vitest";
import type { LoopEvent } from "@/api/types";
import { eventSubject } from "../../../core/event-subjects.ts";
import { queryKeysForEvent } from "./event-keys";

// Events reach the web already normalized, so the fixture derives its subject the same way
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
    subject: partial.subject ?? eventSubject(event.type, event.payload),
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
        payload: { number: 13 },
      }),
    );
    expect(keys).toContainEqual(["issues", "me/proj"]);
    expect(keys).toContainEqual(["issue", "me/proj"]);
  });

  it("falls back to broad issue keys for a repo-less pull_request event (#324)", () => {
    const keys = queryKeysForEvent(
      ev({ type: "pull_request.updated", repo: undefined, payload: {} }),
    );
    expect(keys).toContainEqual(["issues"]);
    expect(keys).toContainEqual(["issue"]);
  });

  it("maps agent_session events to agent-sessions", () => {
    const keys = queryKeysForEvent(ev({ type: "agent_session.registered" }));
    expect(keys).toContainEqual(["agent-sessions"]);
  });

  it("falls back to broad keys when repo is absent", () => {
    const keys = queryKeysForEvent(
      ev({ type: "issue.labeled", repo: undefined, payload: { number: 5 } }),
    );
    expect(keys).toContainEqual(["issues"]);
    expect(keys).toContainEqual(["issue"]);
  });

  it("includes a repo key for any repo-scoped event", () => {
    const keys = queryKeysForEvent(
      ev({ type: "issue.closed", repo: "me/proj", payload: { number: 1 } }),
    );
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

  it("routes agent_session.usage_updated to linked target detail queries", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "agent_session.usage_updated",
        repo: "me/proj",
        payload: { session_id: "s", pr: 7 },
      }),
    );
    expect(keys).toContainEqual(["agent-sessions"]);
    expect(keys).toContainEqual(["pull", "me/proj", 7]);
  });

  it("maps repo.* events to the app-shell repos list (#485)", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "repo.archived",
        repo: "me/proj",
        payload: { full_name: "me/proj" },
      }),
    );
    expect(keys).toContainEqual(["repos"]);
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
    // The new name's repo key comes from the generic repo tail.
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

  it("maps scheduled_task events to the repo's task list and the task's detail (#880)", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "scheduled_task.updated",
        repo: "me/proj",
        payload: { id: 5 },
      }),
    );
    expect(keys).toContainEqual(["scheduled-tasks", "me/proj"]);
    expect(keys).toContainEqual(["scheduled-task", "me/proj", 5]);
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
    ["null", null],
    ["an array", [1, 2]],
    ["a primitive", 12],
    ["missing keys", {}],
  ])("keeps the broad keys and adds no detail key when the payload is %s", (_label, payload) => {
    const keys = queryKeysForEvent(
      ev({ type: "issue.updated", repo: "me/proj", payload }),
    );
    expect(keys).toContainEqual(["issues", "me/proj"]);
    expect(keys).not.toContainEqual(["issue", "me/proj", 12]);
  });

  it("invalidates nothing extra for a repo.renamed whose payload carries no old name", () => {
    const keys = queryKeysForEvent(
      ev({ type: "repo.renamed", repo: "acme/renamed", payload: null }),
    );
    expect(keys).toContainEqual(["repos"]);
    expect(keys).toContainEqual(["repo", "acme/renamed"]);
    expect(keys).not.toContainEqual(["repo", "me/proj"]);
  });
});
