import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-inbox-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-inbox-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/inbox" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("send persists an unread repo-scoped message with optional label and no target", () => {
  const message = svc.inbox.send("me/inbox", {
    from: { kind: "agent", repo: "me/inbox", actor: "impl-bot" },
    label: "review",
    title: "Ready for review",
    body: "Please review PR #1.",
  });

  expect(message).toMatchObject({
    repo: { name: "me/inbox" },
    from: { kind: "agent", repo: "me/inbox", actor: "impl-bot" },
    to: null,
    label: "review",
    title: "Ready for review",
    body: "Please review PR #1.",
    state: "unread",
  });

  const repo = S.getRepo("me", "inbox")!;
  const stored = S.listInboxMessages(repo.id);
  expect(stored).toHaveLength(1);
  expect(JSON.parse(stored[0].from_json)).toEqual(message.from);
});

test("scheduled task source keeps kind, task_id, and run_id", () => {
  const message = svc.inbox.send("me/inbox", {
    from: {
      kind: "scheduled_task",
      repo: "me/inbox",
      task_id: 12,
      run_id: 34,
    },
    to: { kind: "human" },
    title: "Nightly failed",
    body: "The nightly run failed.",
  });

  expect(message.from).toEqual({
    kind: "scheduled_task",
    repo: "me/inbox",
    task_id: 12,
    run_id: 34,
  });
  expect(message.to).toEqual({ kind: "human" });
});

test("send rejects missing or malformed source", () => {
  expect(() =>
    svc.inbox.send("me/inbox", {
      title: "No source",
      body: "body",
    }),
  ).toThrow(/from must be a JSON object/);
  expect(() =>
    svc.inbox.send("me/inbox", {
      from: { kind: "agent", repo: "other/repo", actor: "impl-bot" },
      title: "Wrong repo",
      body: "body",
    }),
  ).toThrow(/from\.repo must match/);
  expect(() =>
    svc.inbox.send("me/inbox", {
      from: { kind: "scheduled_task", repo: "me/inbox", task_id: 1 },
      title: "Bad scheduled source",
      body: "body",
    }),
  ).toThrow(/from\.run_id/);
});
