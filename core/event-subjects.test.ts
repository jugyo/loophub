import { describe, expect, test } from "vitest";
import { eventPayloadRecord, eventSubjects } from "./event-subjects.ts";

describe("eventSubjects", () => {
  test("reads the issue number off issue.* events", () => {
    expect(eventSubjects("issue.opened", { number: 12 })).toEqual([
      { kind: "issue", number: 12 },
    ]);
  });

  test("reads the same key as the PR number on pull_request.* events", () => {
    expect(eventSubjects("pull_request.merged", { number: 12 })).toEqual([
      { kind: "pull", number: 12 },
    ]);
  });

  test("reads the PR number off dev.cost_stopped events", () => {
    expect(eventSubjects("dev.cost_stopped", { number: 12 })).toEqual([
      { kind: "pull", number: 12 },
    ]);
  });

  test("keeps handoff target fields out of the domain subject collection", () => {
    expect(
      eventSubjects("handoff.recorded", {
        pr_number: 13,
        issue_number: 4,
      }),
    ).toEqual([]);
  });

  test("names the run, its issue, and its PR on workflow lifecycle events", () => {
    const payload = { id: 9, issue_number: 4, pr_number: 13 };
    const expected = [
      { kind: "workflow_run", id: 9 },
      { kind: "issue", number: 4 },
      { kind: "pull", number: 13 },
    ];
    expect(eventSubjects("workflow_run.updated", payload)).toEqual(expected);
    expect(eventSubjects("workflow_step.launched", payload)).toEqual(expected);
  });

  test("falls back to `number` for a workflow row written before `pr_number` existed", () => {
    expect(
      eventSubjects("workflow_run.updated", { id: 9, number: 13 }),
    ).toEqual([
      { kind: "workflow_run", id: 9 },
      { kind: "pull", number: 13 },
    ]);
  });

  test("does not read a workflow definition event as a run", () => {
    expect(eventSubjects("workflow.created", { id: 9 })).toEqual([]);
  });

  test("reads the task id off scheduled_task.* events", () => {
    expect(eventSubjects("scheduled_task.updated", { id: 5 })).toEqual([
      { kind: "scheduled_task", id: 5 },
    ]);
  });

  test("keeps agent-session target fields out of the domain subject collection", () => {
    expect(eventSubjects("agent_session.linked", { pr: 13, issue: 4 })).toEqual(
      [],
    );
  });

  test("names nothing for an event type with no known subject", () => {
    expect(eventSubjects("terminal.sessions_updated", { number: 12 })).toEqual(
      [],
    );
  });

  test.each([
    ["null", null],
    ["an array", [1, 2, 3]],
    ["a number", 7],
    ["a string", "12"],
    ["undefined", undefined],
  ])("names nothing when the payload is %s", (_label, payload) => {
    expect(eventSubjects("issue.opened", payload)).toEqual([]);
  });

  test("names nothing when the key is missing or not a number", () => {
    expect(eventSubjects("issue.opened", {})).toEqual([]);
    expect(eventSubjects("issue.opened", { number: "12" })).toEqual([]);
  });

  test("returns a fresh collection per call", () => {
    const first = eventSubjects("issue.opened", { number: 1 });
    const second = eventSubjects("issue.opened", { number: 2 });
    expect(first).toEqual([{ kind: "issue", number: 1 }]);
    expect(second).toEqual([{ kind: "issue", number: 2 }]);
  });
});

describe("eventPayloadRecord", () => {
  test("returns the object for a keyed payload", () => {
    expect(eventPayloadRecord({ from: "me/old" })).toEqual({ from: "me/old" });
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a number", 7],
    ["a string", "from"],
    ["undefined", undefined],
  ])("returns null for %s", (_label, payload) => {
    expect(eventPayloadRecord(payload)).toBeNull();
  });
});
