import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-domain-events-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let domainEvents: typeof import("./domain-events.ts");
let database: typeof import("./db.ts")["db"];
let S: typeof import("./store.ts");

beforeAll(async () => {
  domainEvents = await import("./domain-events.ts");
  ({ db: database } = await import("./db.ts"));
  S = await import("./store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("maps every closure reason to its existing persisted event shape", () => {
  expect(
    domainEvents.persistedEventFor({
      type: "issue.closed",
      repoId: 1,
      actor: "me",
      issueId: 10,
      issueNumber: 2,
      reason: { kind: "manual" },
    }),
  ).toEqual({
    type: "issue.closed",
    payload: { number: 2, source_payload_version: 1 },
  });
  expect(
    domainEvents.persistedEventFor({
      type: "issue.closed",
      repoId: 1,
      actor: "me",
      issueId: 10,
      issueNumber: 2,
      reason: { kind: "pull_merged", pullNumber: 3 },
    }),
  ).toEqual({
    type: "issue.closed",
    payload: { number: 2, closed_by_pull: 3 },
  });

  const basePull = {
    type: "pull.closed" as const,
    repoId: 1,
    actor: "me",
    pullId: 11,
    pullNumber: 3,
    linkedIssueId: 10,
  };
  expect(
    domainEvents.persistedEventFor({
      ...basePull,
      reason: { kind: "manual" },
    }),
  ).toEqual({
    type: "pull_request.updated",
    payload: { number: 3, source_payload_version: 1 },
  });
  expect(
    domainEvents.persistedEventFor({
      ...basePull,
      reason: { kind: "linked_issue_closed", issueNumber: 2 },
    }),
  ).toEqual({
    type: "pull_request.closed",
    payload: { number: 3, linked_issue: 2, source_payload_version: 1 },
  });
  expect(
    domainEvents.persistedEventFor({
      ...basePull,
      reason: { kind: "merged", sha: "abc123", method: "squash" },
    }),
  ).toEqual({
    type: "pull_request.merged",
    payload: { number: 3, sha: "abc123", source_payload_version: 1 },
  });
});

test("rejects publication outside a command transaction", () => {
  expect(() =>
    domainEvents.publish({
      type: "issue.closed",
      repoId: 1,
      actor: "me",
      issueId: 10,
      issueNumber: 2,
      reason: { kind: "manual" },
    }),
  ).toThrowError("domain facts must be published inside a transaction");
});

test("persists a fact even when its subscriber has no applicable reaction", () => {
  const repo = S.createRepo("me/domain-events", "/tmp/domain-events");
  const pull = S.createIssue(repo.id, "pull", "manual close", "", "me");
  S.createPull(pull.id, "feature", "main", null);

  database.transaction(() => {
    S.updateIssue(pull.id, { state: "closed" });
    domainEvents.publish({
      type: "pull.closed",
      repoId: repo.id,
      actor: "me",
      pullId: pull.id,
      pullNumber: pull.number,
      linkedIssueId: null,
      reason: { kind: "manual" },
    });
  });

  expect(S.listEvents(0, repo.id, 10).map((event) => event.type)).toEqual([
    "pull_request.updated",
  ]);
});
