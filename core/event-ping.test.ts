import { expect, test } from "vitest";
import { eventPingIntent } from "./event-ping.ts";

const RUN_SUBJECT = { id: 618, issue_number: 2372, pr_number: 2381 };

test("a run's declarations to its parent ping, and its own lifecycle does not", () => {
  expect(
    eventPingIntent("workflow_run.turn_done", {
      ...RUN_SUBJECT,
      session_id: "execute-session",
      head_sha: "abc",
    }),
  ).toEqual({
    resources: [
      { kind: "workflow_run", key: "618" },
      { kind: "issue", key: "2372" },
      { kind: "pull", key: "2381" },
    ],
    // Turn done and a submitted review are written by a child session, but they are written *for*
    // the subscriber to read — excluding them by session would drop the main trigger of progress.
    echoSessionId: null,
  });
  expect(
    eventPingIntent("pull_request.review_submitted", {
      number: 2381,
      session_id: "verify-session",
      review_id: 7,
    })?.echoSessionId,
  ).toBeNull();

  for (const type of [
    "workflow_run.started",
    "workflow_run.updated",
    "workflow_step.launched",
    "workflow_effect.human_escalation",
  ]) {
    expect(eventPingIntent(type, RUN_SUBJECT)).toBeNull();
  }
});

test("escalation, cost boundaries and external facts ping unconditionally", () => {
  for (const [type, payload] of [
    ["workflow_run.escalated", { ...RUN_SUBJECT, reason: "needs a decision" }],
    ["workflow_run.cost_exceeded", { id: 618, number: 2381, limit_usd: 5 }],
    ["workflow_run.cost_limit_increased", RUN_SUBJECT],
    ["pull_request.github_feedback", { number: 2381 }],
    ["pull_request.merge_conflict", { number: 2381 }],
  ] as const) {
    expect(eventPingIntent(type, payload)?.echoSessionId).toBeNull();
  }
});

test("a comment pings only when a human wrote it", () => {
  expect(
    eventPingIntent("issue.commented", {
      number: 2372,
      author_type: "human",
    })?.resources,
  ).toEqual([{ kind: "issue", key: "2372" }]);
  expect(
    eventPingIntent("pull_request.commented", {
      number: 2381,
      author_type: "human",
    })?.resources,
  ).toEqual([{ kind: "pull", key: "2381" }]);

  for (const authorType of ["agent", "system"]) {
    expect(
      eventPingIntent("issue.commented", {
        number: 2372,
        author_type: authorType,
      }),
    ).toBeNull();
  }
  // A row written before the key existed is not read as a human's comment.
  expect(eventPingIntent("issue.commented", { number: 2372 })).toBeNull();
});

test("diff feedback carries the writing session so the writer is not woken by it", () => {
  for (const type of [
    "pull_request.diff_feedback_created",
    "pull_request.diff_feedback_replied",
  ]) {
    expect(
      eventPingIntent(type, { number: 2381, session_id: "execute-session" }),
    ).toEqual({
      resources: [{ kind: "pull", key: "2381" }],
      echoSessionId: "execute-session",
    });
    // A human writes without a session; there is nobody the reply could echo back to.
    expect(
      eventPingIntent(type, { number: 2381, session_id: null })?.echoSessionId,
    ).toBeNull();
  }
});

test("closing, merging and the sweeps are read as state instead of announced", () => {
  for (const type of [
    "pull_request.closed",
    "pull_request.merged",
    "pull_request.github_merged",
    "pull_request.updated",
    "pull_request.ready_for_review",
    "issue.closed",
    "terminal.sessions_updated",
    "workflow.run_started",
    "workflow.run_completed",
    "workflow_run.diff_feedback",
    "workflow_run.pr_comment",
    "workflow_run.github_event",
    "workflow_run.review_submitted",
    "workflow_run.merge_conflict",
    "workflow_run.merged",
    "workflow_run.closed",
  ]) {
    expect(eventPingIntent(type, { ...RUN_SUBJECT, number: 2381 })).toBeNull();
  }
});

test("a payload naming no resource wakes nobody", () => {
  expect(eventPingIntent("pull_request.merge_conflict", {})).toBeNull();
  expect(eventPingIntent("pull_request.merge_conflict", null)).toBeNull();
  expect(eventPingIntent("workflow_run.turn_done", "not-an-object")).toBeNull();
});
