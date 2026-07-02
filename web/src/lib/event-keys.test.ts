import { describe, expect, it } from "vitest";
import type { LoopEvent } from "@/api/types";
import { queryKeysForEvent } from "./event-keys";

function ev(partial: Partial<LoopEvent>): LoopEvent {
  return {
    id: 1,
    type: "issue.opened",
    actor: "impl-bot",
    payload: {},
    created_at: "2026-06-17T00:00:00Z",
    ...partial,
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

  it("maps dev.note events to the target PR detail + pulls list", () => {
    const keys = queryKeysForEvent(
      ev({
        type: "dev.note",
        repo: "me/proj",
        payload: { issue_number: 7, pr_number: 8, kind: "decision" },
      }),
    );
    expect(keys).toContainEqual(["pulls", "me/proj"]);
    expect(keys).toContainEqual(["pull", "me/proj", 8]);
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

  it("maps issue_group events to the repo's issue list + all issue details (#314)", () => {
    // The issue-detail "other issues in the same group" list is a sub-key of the issue key, so a
    // membership/rename/delete change must invalidate open issue details by prefix — the payload
    // carries at most one issue number, but rename/delete affect every member of the group.
    const keys = queryKeysForEvent(
      ev({
        type: "issue_group.issue_added",
        repo: "me/proj",
        payload: { group_id: 1, number: 12 },
      }),
    );
    expect(keys).toContainEqual(["issues", "me/proj"]);
    expect(keys).toContainEqual(["issue", "me/proj"]);
    // It must NOT be misrouted by the issue.* branch (which would push the dashboard key).
    expect(keys).not.toContainEqual(["dashboard"]);
  });

  it("falls back to broad issue keys for a repo-less issue_group event (#314)", () => {
    const keys = queryKeysForEvent(
      ev({ type: "issue_group.deleted", repo: undefined, payload: {} }),
    );
    expect(keys).toContainEqual(["issues"]);
    expect(keys).toContainEqual(["issue"]);
  });

  it("maps settings.updated to the settings view and terminal config, with no repo key (#474)", () => {
    const keys = queryKeysForEvent(
      ev({ type: "settings.updated", repo: undefined, payload: {} }),
    );
    expect(keys).toContainEqual(["settings"]);
    expect(keys).toContainEqual(["terminal", "config"]);
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

  it("maps repo.* events to the sidebar repos list (#485)", () => {
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
});
