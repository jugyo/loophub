import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-notifications-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
const repoDirs: string[] = [];

function initGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  repoDirs.push(dir);
  const g = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(dir, "a.txt"), "x\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return dir;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  const repoPath = initGitRepo("lh-notifications-repo-");
  await svc.repos.create({ path: repoPath, name: "me/notify" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true });
});

test("list backfills the three notification kinds from durable PR signals", () => {
  const repo = S.getRepo("me", "notify")!;
  const done = S.createIssue(repo.id, "pull", "Done PR", "", "me");
  S.createPull(done.id, "done", "main", "sha1", null);
  const over = S.createIssue(repo.id, "pull", "Cost PR", "", "me");
  S.createPull(over.id, "cost", "main", "sha2", null);
  const attention = S.createIssue(repo.id, "pull", "Needs PR", "", "me");
  S.createPull(attention.id, "needs", "main", "sha3", null);

  S.emitEvent(repo.id, "pull_request.ready_for_review", "lh-build", {
    number: done.number,
    draft: false,
  });
  S.emitEvent(repo.id, "dev.cost_stopped", "lh-worker", {
    number: over.number,
    session_id: "session-1",
  });
  S.createReview(attention.id, "reviewer", "REQUEST_CHANGES", "fix this");

  const notifications = svc.notifications.list({ limit: 20 });
  expect(notifications).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "implementation_done",
        title: "Implementation complete",
        resource: {
          kind: "pull",
          number: done.number,
          href: "/r/me/notify/pulls/1",
        },
      }),
      expect.objectContaining({
        kind: "over_budget",
        title: "Over budget",
        resource: {
          kind: "pull",
          number: over.number,
          href: "/r/me/notify/pulls/2",
        },
      }),
      expect.objectContaining({
        kind: "human_attention",
        title: "Human attention needed",
        resource: {
          kind: "pull",
          number: attention.number,
          href: "/r/me/notify/pulls/3",
        },
      }),
    ]),
  );
  expect(svc.notifications.unreadCount().count).toBe(3);

  svc.notifications.list({ limit: 20 });
  expect(svc.notifications.unreadCount().count).toBe(3);
});

test("read marks a notification without removing it from the persisted list", () => {
  const [notification] = svc.notifications.list({ limit: 1 });

  const read = svc.notifications.read(notification.id, "web-session");

  expect(read.read_at).toEqual(expect.any(String));
  expect(svc.notifications.unreadCount().count).toBe(2);
  expect(svc.notifications.list({ limit: 20 }).map((n: any) => n.id)).toContain(
    notification.id,
  );
});

test("send creates an agent-triggered notification", () => {
  const before = svc.notifications.unreadCount().count;
  const notification = svc.notifications.send(
    "me/notify",
    {
      kind: "human_attention",
      title: "Needs review",
      body: "Please check PR #42.",
      resourceKind: "pull",
      resourceNumber: 42,
      sourceKey: "cli-test:review",
      herdrPaneId: "w1:p2",
    },
    "agent-session",
  );

  expect(notification).toMatchObject({
    kind: "human_attention",
    title: "Needs review",
    body: "Please check PR #42.",
    resource: {
      kind: "pull",
      number: 42,
      href: "/r/me/notify/pulls/42",
    },
    herdr_pane_id: "w1:p2",
    read_at: null,
  });
  expect(svc.notifications.unreadCount().count).toBe(before + 1);
});

test("backfill defers reversible hidden states but ignores merged PR signals", () => {
  const repo = S.getRepo("me", "notify")!;
  const closed = S.createIssue(repo.id, "pull", "Closed PR", "", "me");
  S.createPull(closed.id, "closed", "main", "sha-closed", null);
  const archived = S.createIssue(repo.id, "pull", "Archived PR", "", "me");
  S.createPull(archived.id, "archived", "main", "sha-archived", null);
  const merged = S.createIssue(repo.id, "pull", "Merged PR", "", "me");
  S.createPull(merged.id, "merged", "main", "sha-merged", null);

  S.emitEvent(repo.id, "pull_request.ready_for_review", "lh-build", {
    number: closed.number,
    draft: false,
  });
  S.emitEvent(repo.id, "dev.cost_stopped", "lh-worker", {
    number: archived.number,
    session_id: "session-archived",
  });
  S.emitEvent(repo.id, "dev.cost_stopped", "lh-worker", {
    number: merged.number,
    session_id: "session-merged",
  });
  S.updateIssue(closed.id, { state: "closed" });
  S.setRepoArchived(repo.id, true);
  S.setMergedFromGithub(merged.id, "2026-01-01T00:00:00Z");

  let notifications = svc.notifications.list({ limit: 100 });

  expect(
    notifications.some(
      (n: any) =>
        n.resource.kind === "pull" && n.resource.number === closed.number,
    ),
  ).toBe(false);
  expect(
    notifications.some(
      (n: any) =>
        n.resource.kind === "pull" && n.resource.number === merged.number,
    ),
  ).toBe(false);

  S.setRepoArchived(repo.id, false);
  S.updateIssue(closed.id, { state: "open" });

  notifications = svc.notifications.list({ limit: 100 });
  expect(
    notifications.some(
      (n: any) =>
        n.resource.kind === "pull" && n.resource.number === closed.number,
    ),
  ).toBe(true);
  expect(
    notifications.some(
      (n: any) =>
        n.resource.kind === "pull" && n.resource.number === archived.number,
    ),
  ).toBe(true);
  expect(
    notifications.some(
      (n: any) =>
        n.resource.kind === "pull" && n.resource.number === merged.number,
    ),
  ).toBe(false);
});

test("human-attention backfill follows the latest substantive review", () => {
  const repo = S.getRepo("me", "notify")!;
  const resolved = S.createIssue(repo.id, "pull", "Resolved PR", "", "me");
  S.createPull(resolved.id, "resolved", "main", "sha-resolved", null);
  S.createReview(resolved.id, "reviewer", "REQUEST_CHANGES", "fix this");
  S.createReview(resolved.id, "reviewer", "PASS", "fixed");

  let notifications = svc.notifications.list({ limit: 100 });
  expect(
    notifications.some(
      (n: any) =>
        n.kind === "human_attention" &&
        n.resource.kind === "pull" &&
        n.resource.number === resolved.number,
    ),
  ).toBe(false);

  const changed = S.createIssue(repo.id, "pull", "Changed PR", "", "me");
  S.createPull(changed.id, "changed", "main", "sha-changed", null);
  S.createReview(changed.id, "reviewer", "REQUEST_CHANGES", "first");
  notifications = svc.notifications.list({ limit: 100 });
  expect(
    notifications.filter(
      (n: any) =>
        n.kind === "human_attention" &&
        n.resource.kind === "pull" &&
        n.resource.number === changed.number,
    ),
  ).toHaveLength(1);

  S.createReview(changed.id, "reviewer", "PASS", "fixed");
  svc.notifications.unreadCount();
  S.createReview(changed.id, "reviewer", "REQUEST_CHANGES", "again");

  notifications = svc.notifications.list({ limit: 100 });
  expect(
    notifications.filter(
      (n: any) =>
        n.kind === "human_attention" &&
        n.resource.kind === "pull" &&
        n.resource.number === changed.number,
    ),
  ).toHaveLength(2);
});

test("human-attention backfill follows the latest substantive review per topic", () => {
  const repo = S.getRepo("me", "notify")!;
  const pr = S.createIssue(repo.id, "pull", "Topic PR", "", "me");
  S.createPull(pr.id, "topic", "main", "sha-topic", null);
  S.createReview(
    pr.id,
    "reviewer",
    "REQUEST_CHANGES",
    "quality changes",
    null,
    "quality",
  );
  S.createReview(
    pr.id,
    "reviewer",
    "PASS",
    "security passed",
    null,
    "security",
  );

  const notifications = svc.notifications.list({ limit: 100 });

  expect(
    notifications.filter(
      (n: any) =>
        n.kind === "human_attention" &&
        n.resource.kind === "pull" &&
        n.resource.number === pr.number,
    ),
  ).toHaveLength(1);
});

test("backfill creates a notification for each repeated cost stop event", () => {
  const repo = S.getRepo("me", "notify")!;
  const pr = S.createIssue(repo.id, "pull", "Repeated cost PR", "", "me");
  S.createPull(pr.id, "cost-again", "main", "sha-cost-again", null);

  S.emitEvent(repo.id, "dev.cost_stopped", "lh-worker", {
    number: pr.number,
    session_id: "session-cost-1",
  });
  S.emitEvent(repo.id, "dev.cost_stopped", "lh-worker", {
    number: pr.number,
    session_id: "session-cost-2",
  });

  const notifications = svc.notifications.list({ limit: 100 });

  expect(
    notifications.filter(
      (n: any) =>
        n.kind === "over_budget" &&
        n.resource.kind === "pull" &&
        n.resource.number === pr.number,
    ),
  ).toHaveLength(2);
});

test("read marks notifications for archived repos", () => {
  const repo = S.getRepo("me", "notify")!;
  const notification = svc.notifications.send(
    "me/notify",
    {
      kind: "human_attention",
      title: "Archived repo notice",
      body: "This can still be read.",
      resourceKind: "repo",
      sourceKey: "cli-test:archived-read",
    },
    "agent-session",
  );

  S.setRepoArchived(repo.id, true);
  let read: any;
  try {
    read = svc.notifications.read(notification.id, "web-session");
  } finally {
    S.setRepoArchived(repo.id, false);
  }

  expect(read.read_at).toEqual(expect.any(String));
});

test("repo removal deletes persisted notifications before deleting the repo", async () => {
  const repoPath = initGitRepo("lh-notifications-remove-repo-");
  await svc.repos.create({ path: repoPath, name: "me/notify-remove" });
  svc.notifications.send("me/notify-remove", {
    kind: "human_attention",
    title: "Remove repo notice",
    body: "This notification should not block repo removal.",
    resourceKind: "repo",
    sourceKey: "cli-test:remove-repo",
  });

  expect(() => svc.repos.remove("me/notify-remove")).not.toThrow();
  expect(S.getRepo("me", "notify-remove")).toBeNull();
});

test("send namespaces user source keys away from reserved backfill keys", () => {
  const repo = S.getRepo("me", "notify")!;
  const reservedKey = `cost:${repo.id}:999`;
  const reserved = S.createNotification({
    repoId: repo.id,
    kind: "over_budget",
    title: "Reserved",
    body: "Reserved source key.",
    resourceKind: "pull",
    resourceNumber: 999,
    sourceKey: reservedKey,
  });

  const sent = svc.notifications.send(
    "me/notify",
    {
      kind: "over_budget",
      title: "CLI",
      body: "User supplied a reserved-looking source key.",
      resourceKind: "pull",
      resourceNumber: 999,
      sourceKey: reservedKey,
    },
    "agent-session",
  );

  expect(reserved).not.toBeNull();
  expect(sent.id).not.toBe(reserved?.id);
});

test("send enforces bounded title and body lengths", () => {
  expect(() =>
    svc.notifications.send("me/notify", {
      kind: "human_attention",
      title: "x".repeat(201),
      body: "short",
      resourceKind: "repo",
      sourceKey: "cli-test:title-too-long",
    }),
  ).toThrow("title must be 200 characters or fewer");

  expect(() =>
    svc.notifications.send("me/notify", {
      kind: "human_attention",
      title: "Body too long",
      body: "x".repeat(4097),
      resourceKind: "repo",
      sourceKey: "cli-test:body-too-long",
    }),
  ).toThrow("body must be 4096 characters or fewer");
});
