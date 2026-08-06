import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB/HOME before importing any core module (db.ts opens at import time).
// agent-comment-notifications.ts statically imports store → db, so it must be loaded only after
// LOOPHUB_* is set — a static import at the top of this file would open ~/.loophub/loophub.db.
const HOME = mkdtempSync(join(tmpdir(), "lh-agent-comment-notify-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let maybeNotifyAgentComment: typeof import("./agent-comment-notifications.ts").maybeNotifyAgentComment;
let S: typeof import("./store.ts");
let repoId: number;
let pullNumber: number;

beforeAll(async () => {
  ({ maybeNotifyAgentComment } = await import(
    "./agent-comment-notifications.ts"
  ));
  S = await import("./store.ts");
  const repo = S.createRepo(
    `me/agent-comment-${Date.now()}`,
    join(HOME, "repo"),
  );
  repoId = repo.id;
  const pull = S.createIssue(repoId, "pull", "Agent comment PR", "", "me");
  S.createPull(pull.id, "feature", "main", "sha", null);
  pullNumber = pull.number;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("creates an agent_comment notification only for agent authors", () => {
  const sourceKey = `agent-comment:pr:${repoId}:101`;
  const created = maybeNotifyAgentComment({
    repoId,
    pullNumber,
    commentId: 101,
    authorType: "agent",
    actor: "executor #1-1",
    body: "Implemented the change.",
    source: "pr",
  });
  expect(created).toMatchObject({
    kind: "agent_comment",
    title: "Agent comment",
    body: "executor #1-1: Implemented the change.",
    resource_kind: "pull",
    resource_number: pullNumber,
    source_key: sourceKey,
  });

  expect(
    maybeNotifyAgentComment({
      repoId,
      pullNumber,
      commentId: 102,
      authorType: "human",
      actor: "me",
      body: "Please rename this.",
      source: "pr",
    }),
  ).toBeNull();
  expect(
    maybeNotifyAgentComment({
      repoId,
      pullNumber,
      commentId: 103,
      authorType: "system",
      actor: "unknown",
      body: "Automated note.",
      source: "pr",
    }),
  ).toBeNull();

  const listed = S.listNotifications({ unreadOnly: true }).filter(
    (row) => row.source_key === sourceKey,
  );
  expect(listed).toHaveLength(1);
  expect(listed[0].id).toBe(created!.id);
});

test("reuses source_key so the same comment does not notify twice", () => {
  const sourceKey = `agent-comment:diff:${repoId}:201`;
  const first = maybeNotifyAgentComment({
    repoId,
    pullNumber,
    commentId: 201,
    authorType: "agent",
    actor: "executor #1-1",
    body: "First write.",
    source: "diff",
  });
  const second = maybeNotifyAgentComment({
    repoId,
    pullNumber,
    commentId: 201,
    authorType: "agent",
    actor: "executor #1-1",
    body: "First write.",
    source: "diff",
  });
  expect(first).not.toBeNull();
  expect(second).toBeNull();
  expect(
    S.listNotifications({ unreadOnly: true }).filter(
      (row) => row.source_key === sourceKey,
    ),
  ).toHaveLength(1);
});

test("truncates long bodies for the notification preview", () => {
  const long = "x".repeat(400);
  const row = maybeNotifyAgentComment({
    repoId,
    pullNumber,
    commentId: 301,
    authorType: "agent",
    actor: "bot",
    body: long,
    source: "pr",
  });
  expect(row?.body.startsWith("bot: ")).toBe(true);
  expect(row?.body.endsWith("…")).toBe(true);
  expect(row!.body.length).toBeLessThan(long.length);
  expect(
    S.listNotifications({ unreadOnly: true }).filter(
      (row) => row.source_key === `agent-comment:pr:${repoId}:301`,
    ),
  ).toHaveLength(1);
});
