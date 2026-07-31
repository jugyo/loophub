import { describe, expect, test } from "vitest";
import {
  emptyEventSubject,
  eventPayloadFields,
  eventSubject,
} from "./event-subjects.ts";

describe("eventSubject", () => {
  test("reads the issue number off issue.* events", () => {
    expect(eventSubject("issue.opened", { number: 12 })).toEqual({
      ...emptyEventSubject(),
      issue_number: 12,
    });
  });

  test("reads the same key as the PR number on pull_request.* events", () => {
    expect(eventSubject("pull_request.merged", { number: 12 })).toEqual({
      ...emptyEventSubject(),
      pull_number: 12,
    });
  });

  test("names both subjects of a handoff filed against a PR and an issue", () => {
    expect(
      eventSubject("handoff.recorded", { pr_number: 13, issue_number: 4 }),
    ).toEqual({
      ...emptyEventSubject(),
      pull_number: 13,
      issue_number: 4,
    });
  });

  test("falls back to `number` for a handoff written before `pr_number` existed", () => {
    expect(eventSubject("handoff.recorded", { number: 13 })).toEqual({
      ...emptyEventSubject(),
      pull_number: 13,
    });
  });

  test("leaves the PR empty for an issue-only handoff", () => {
    expect(eventSubject("handoff.recorded", { issue_number: 4 })).toEqual({
      ...emptyEventSubject(),
      issue_number: 4,
    });
  });

  test("names the run, its issue, and its PR on workflow lifecycle events", () => {
    const payload = { id: 9, issue_number: 4, pr_number: 13 };
    expect(eventSubject("workflow_run.updated", payload)).toEqual({
      issue_number: 4,
      pull_number: 13,
      workflow_run_id: 9,
      scheduled_task_id: null,
    });
    expect(eventSubject("workflow_step.launched", payload)).toEqual({
      issue_number: 4,
      pull_number: 13,
      workflow_run_id: 9,
      scheduled_task_id: null,
    });
  });

  test("does not read a workflow definition event as a run", () => {
    expect(eventSubject("workflow.created", { id: 9 })).toEqual(
      emptyEventSubject(),
    );
  });

  test("reads the task id off scheduled_task.* events", () => {
    expect(eventSubject("scheduled_task.updated", { id: 5 })).toEqual({
      ...emptyEventSubject(),
      scheduled_task_id: 5,
    });
  });

  test("reads an agent session's linked targets", () => {
    expect(eventSubject("agent_session.linked", { pr: 13, issue: 4 })).toEqual({
      ...emptyEventSubject(),
      pull_number: 13,
      issue_number: 4,
    });
  });

  test("names nothing for an event type with no known subject", () => {
    expect(eventSubject("terminal.sessions_updated", { number: 12 })).toEqual(
      emptyEventSubject(),
    );
  });

  test.each([
    ["null", null],
    ["an array", [1, 2, 3]],
    ["a number", 7],
    ["a string", "12"],
    ["undefined", undefined],
  ])("names nothing when the payload is %s", (_label, payload) => {
    expect(eventSubject("issue.opened", payload)).toEqual(emptyEventSubject());
  });

  test("names nothing when the key is missing or not a number", () => {
    expect(eventSubject("issue.opened", {})).toEqual(emptyEventSubject());
    expect(eventSubject("issue.opened", { number: "12" })).toEqual(
      emptyEventSubject(),
    );
  });

  test("returns a fresh subject per call", () => {
    const first = eventSubject("issue.opened", { number: 1 });
    const second = eventSubject("issue.opened", { number: 2 });
    expect(first.issue_number).toBe(1);
    expect(second.issue_number).toBe(2);
  });
});

describe("eventPayloadFields", () => {
  test("returns the object for a keyed payload", () => {
    expect(eventPayloadFields({ from: "me/old" })).toEqual({ from: "me/old" });
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a number", 7],
    ["a string", "from"],
    ["undefined", undefined],
  ])("returns null for %s", (_label, payload) => {
    expect(eventPayloadFields(payload)).toBeNull();
  });
});
