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
      ev({ type: "issue.assigned", repo: "me/proj", payload: { number: 1 } }),
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
});
