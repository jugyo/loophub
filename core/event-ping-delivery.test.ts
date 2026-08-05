import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-event-ping-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

const BIN = mkdtempSync(join(tmpdir(), "lh-event-ping-herdr-"));
const CALLS = join(BIN, "calls.log");
const ORIGINAL_PATH = process.env.PATH;

let S: typeof import("./store.ts");
let svc: typeof import("./service.ts");

beforeAll(async () => {
  S = await import("./store.ts");
  svc = await import("./service.ts");
  // A stand-in for Herdr that records the arguments a pane write would have carried.
  writeFileSync(
    join(BIN, "herdr"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${CALLS}'`,
      'if [ "$HERDR_FAIL" = "1" ]; then exit 9; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(BIN, "herdr"), 0o755);
  process.env.PATH = `${BIN}:${ORIGINAL_PATH}`;
});

beforeEach(() => {
  rmSync(CALLS, { force: true });
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  rmSync(HOME, { recursive: true, force: true });
  rmSync(BIN, { recursive: true, force: true });
});

function fixture(name: string) {
  const repo = S.createRepo(`me/${name}`, mkdtempSync(join(tmpdir(), "lh-")));
  const issue = S.createIssue(repo.id, "issue", "Issue", "", "me");
  const pr = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(pr.id, "feature", "main", "head", null);
  const workflow = S.createWorkflow({
    name: `workflow-${name}`,
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const run = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: pr.number,
    status: "running",
    currentStep: "execute",
    parentSessionId: `${name}-parent`,
    costIncrementUsd: 5,
    costLimitUsd: 5,
  });
  const subscription = svc.events.subscribe({
    repo: repo.full_name,
    target: "herdr-pane",
    session: `${name}-session`,
    pane: "w1:p1",
    resources: [
      `workflow_run:${run.id}`,
      `issue:${issue.number}`,
      `pull:${pr.number}`,
    ],
  });
  return { repo, issue, pr, run, subscription };
}

function paneWrites(): string[] {
  return existsSync(CALLS)
    ? readFileSync(CALLS, "utf8").split("\n").filter(Boolean)
    : [];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Delivery is fire-and-forget, so an assertion waits for the pane write rather than for the call
// that started it. One prompt is two Herdr requests: the text, then the submit.
async function waitForPaneWrites(expected: number): Promise<string[]> {
  for (let attempt = 0; attempt < 100 && paneWrites().length < expected; ) {
    attempt++;
    await sleep(20);
  }
  return paneWrites();
}

// What was written once nothing more is coming — the shape an "and nobody else was woken"
// assertion needs.
async function settledPaneWrites(): Promise<string[]> {
  await sleep(300);
  return paneWrites();
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); ) {
    attempt++;
    await sleep(20);
  }
}

test("a subscriber is woken once, with the identity of what it subscribed to", async () => {
  const { repo, run, issue, pr, subscription } = fixture("wake");
  S.emitEvent(repo.id, "workflow_run.turn_done", "executor", {
    id: run.id,
    issue_number: issue.number,
    pr_number: pr.number,
    number: pr.number,
    session_id: "execute-session",
    head_sha: "abc",
  });

  // One event naming the run, its issue and its PR is still one thing to look at.
  const [text, submit] = await waitForPaneWrites(2);
  expect(text).toContain(
    `ping subscription=${subscription.id} resources=workflow_run:${run.id},issue:${issue.number},pull:${pr.number}`,
  );
  expect(submit).toContain("send-keys");
  expect(await settledPaneWrites()).toHaveLength(2);
});

test("the wake-up carries no event id, action or comment text", async () => {
  const { repo, pr } = fixture("payload-free");
  svc.comments.createHumanForPull(repo.full_name, pr.number, "直してください");

  const [text] = await waitForPaneWrites(2);
  expect(text).toContain(`resources=pull:${pr.number}`);
  expect(text).not.toContain("直してください");
  expect(text).not.toMatch(/event|comment|commented/);
});

test("an agent's own comment is not input and wakes nobody", async () => {
  const { repo, issue } = fixture("agent-comment");
  const session = "00000000-0000-4000-8000-0000000000a1";
  S.registerAgentSession(
    session,
    "claude-code",
    session,
    null,
    "claude-code",
    "dev",
    "auto",
    new Date().toISOString(),
  );
  svc.comments.create(repo.full_name, issue.number, "進捗メモ", session);
  expect(await settledPaneWrites()).toEqual([]);

  // The same issue with a human writing on it does wake the subscriber.
  svc.comments.createHumanForIssue(repo.full_name, issue.number, "続けて");
  expect(await waitForPaneWrites(2)).toHaveLength(2);
});

test("a run's own reply to a diff feedback thread is not delivered back to it", async () => {
  const { repo, run, pr } = fixture("diff-feedback-echo");
  const child = "00000000-0000-4000-8000-0000000000b1";
  S.registerAgentSession(
    child,
    "claude-code",
    child,
    null,
    "claude-code",
    "dev",
    "auto",
    new Date().toISOString(),
  );
  S.appendWorkflowRunStepSession(run.id, "execute", child);

  S.emitEvent(repo.id, "pull_request.diff_feedback_replied", "executor", {
    number: pr.number,
    thread_id: 1,
    reply_message_id: 2,
    session_id: child,
  });
  expect(await settledPaneWrites()).toEqual([]);

  // A human writing in the same thread is ordinary input.
  S.emitEvent(repo.id, "pull_request.diff_feedback_replied", "me", {
    number: pr.number,
    thread_id: 1,
    reply_message_id: 3,
    session_id: null,
  });
  expect(await waitForPaneWrites(2)).toHaveLength(2);
});

test("a rolled back write wakes nobody, and a committed one wakes once", async () => {
  const { repo, run, pr } = fixture("rollback");
  const { db } = await import("./db.ts");
  expect(() =>
    db.transaction(() => {
      S.emitEvent(repo.id, "pull_request.merge_conflict", "lh-worker", {
        number: pr.number,
        run_id: run.id,
      });
      throw new Error("command failed");
    }),
  ).toThrow("command failed");
  expect(await settledPaneWrites()).toEqual([]);

  db.transaction(() => {
    S.emitEvent(repo.id, "pull_request.merge_conflict", "lh-worker", {
      number: pr.number,
      run_id: run.id,
    });
  });
  expect(await waitForPaneWrites(2)).toHaveLength(2);
});

test("a conditional insert that inserted nothing announces nothing", async () => {
  const { repo, run, pr } = fixture("conditional-insert");
  const payload = {
    id: run.id,
    number: pr.number,
    pr_number: pr.number,
    parent_session_id: run.parent_session_id,
    session_id: "usage-session",
    usage_session_id: "usage-session",
    active_step: "execute",
    active_session_id: "execute-session",
    cost_usd: 6,
    limit_usd: 5,
    increment_usd: 5,
    next_limit_usd: 10,
  };
  expect(
    S.emitWorkflowRunCostExceeded(repo.id, "lh-worker", payload, 60_000),
  ).not.toBeNull();
  expect(await waitForPaneWrites(2)).toHaveLength(2);

  // The re-emit window suppresses the row, so there is no new fact to announce.
  expect(
    S.emitWorkflowRunCostExceeded(repo.id, "lh-worker", payload, 60_000),
  ).toBeNull();
  expect(await settledPaneWrites()).toHaveLength(2);
});

test("an undelivered wake-up is reported and the write it announced stands", async () => {
  const { repo, pr, subscription } = fixture("undeliverable");
  const { pingEventSubscribers } = await import("./event-ping-delivery.ts");
  const failures: string[] = [];
  process.env.HERDR_FAIL = "1";
  try {
    pingEventSubscribers(
      {
        repo_id: repo.id,
        type: "pull_request.merge_conflict",
        payload: JSON.stringify({ number: pr.number }),
      },
      (message) => failures.push(message),
    );
    // The caller is not blocked by the delivery, and the failure is reported rather than retried.
    expect(failures).toEqual([]);
    await waitFor(() => failures.length > 0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(
      `event ping delivery failed subscription_id=${subscription.id}`,
    );
  } finally {
    delete process.env.HERDR_FAIL;
  }
});
