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
let primaryRepoPath: string;

function git(dir: string, args: string[]) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function initGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  repoDirs.push(dir);
  const g = (args: string[]) => git(dir, args);
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
  primaryRepoPath = initGitRepo("lh-notifications-repo-");
  await svc.repos.create({ path: primaryRepoPath, name: "me/notify" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true });
});

test("list generates merge-ready, over-budget, and human-attention notifications", async () => {
  const repo = S.getRepo("me", "notify")!;
  const done = S.createIssue(repo.id, "pull", "Done PR", "", "me");
  git(primaryRepoPath, ["checkout", "-qb", "done"]);
  writeFileSync(join(primaryRepoPath, "done.txt"), "done\n");
  git(primaryRepoPath, ["add", "done.txt"]);
  git(primaryRepoPath, ["commit", "-qm", "done"]);
  const doneSha = git(primaryRepoPath, ["rev-parse", "HEAD"]).stdout.trim();
  git(primaryRepoPath, ["checkout", "-q", "main"]);
  S.createPull(done.id, "done", "main", doneSha, null);
  S.createReview(done.id, "reviewer", "PASS", "looks good", doneSha);
  const over = S.createIssue(repo.id, "pull", "Cost PR", "", "me");
  S.createPull(over.id, "cost", "main", "sha2", null);
  const attention = S.createIssue(repo.id, "pull", "Needs PR", "", "me");
  S.createPull(attention.id, "needs", "main", "sha3", null);

  S.emitEvent(repo.id, "dev.cost_stopped", "lh-worker", {
    number: over.number,
    session_id: "session-1",
  });
  S.createReview(attention.id, "reviewer", "REQUEST_CHANGES", "fix this");

  const notifications = await svc.notifications.list({ limit: 20 });
  expect(notifications).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "merge_ready",
        title: "Ready to merge",
        body: `PR #${done.number} in me/notify is ready to merge.`,
        resource: {
          kind: "pull",
          number: done.number,
          title: "Done PR",
          href: "/r/me/notify/pulls/1",
        },
      }),
      expect.objectContaining({
        kind: "over_budget",
        title: "Over budget",
        resource: {
          kind: "pull",
          number: over.number,
          title: "Cost PR",
          href: "/r/me/notify/pulls/2",
        },
      }),
      expect.objectContaining({
        kind: "human_attention",
        title: "Human attention needed",
        resource: {
          kind: "pull",
          number: attention.number,
          title: "Needs PR",
          href: "/r/me/notify/pulls/3",
        },
      }),
    ]),
  );
  expect((await svc.notifications.unreadCount()).count).toBe(3);

  await svc.notifications.list({ limit: 20 });
  expect((await svc.notifications.unreadCount()).count).toBe(3);
});

test("ready-for-review alone does not generate a notification", async () => {
  const repo = S.getRepo("me", "notify")!;
  const pr = S.createIssue(repo.id, "pull", "Draft complete", "", "me");
  S.createPull(pr.id, "main", "main", null, null);
  S.emitEvent(repo.id, "pull_request.ready_for_review", "lh-build", {
    number: pr.number,
  });

  const notifications = await svc.notifications.list({ limit: 100 });

  expect(
    notifications.some(
      (n: any) => n.resource.kind === "pull" && n.resource.number === pr.number,
    ),
  ).toBe(false);
});

test("merge-ready notifications follow clean transitions without sweep duplicates", async () => {
  const repoPath = initGitRepo("lh-notifications-transitions-");
  await svc.repos.create({ path: repoPath, name: "me/notify-transitions" });
  const repo = S.getRepo("me", "notify-transitions")!;

  const noCommits = S.createIssue(repo.id, "pull", "No commits", "", "me");
  S.createPull(noCommits.id, "main", "main", null, null);

  git(repoPath, ["checkout", "-qb", "blocked"]);
  writeFileSync(join(repoPath, "blocked.txt"), "blocked\n");
  git(repoPath, ["add", "blocked.txt"]);
  git(repoPath, ["commit", "-qm", "blocked"]);
  const blockedSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
  git(repoPath, ["checkout", "-q", "main"]);
  const blocked = S.createIssue(repo.id, "pull", "Blocked", "", "me");
  S.createPull(blocked.id, "blocked", "main", blockedSha, null);

  git(repoPath, ["checkout", "-qb", "conflict"]);
  writeFileSync(join(repoPath, "a.txt"), "head\n");
  git(repoPath, ["add", "a.txt"]);
  git(repoPath, ["commit", "-qm", "head conflict"]);
  const conflictSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
  git(repoPath, ["checkout", "-q", "main"]);
  writeFileSync(join(repoPath, "a.txt"), "base\n");
  git(repoPath, ["add", "a.txt"]);
  git(repoPath, ["commit", "-qm", "base conflict"]);
  const conflict = S.createIssue(repo.id, "pull", "Conflict", "", "me");
  S.createPull(conflict.id, "conflict", "main", conflictSha, null);
  S.createReview(conflict.id, "reviewer", "PASS", "passed", conflictSha);

  const unknown = S.createIssue(repo.id, "pull", "Unknown", "", "me");
  S.createPull(unknown.id, "missing", "main", null, null);

  git(repoPath, ["checkout", "-qb", "clean"]);
  writeFileSync(join(repoPath, "clean.txt"), "clean\n");
  git(repoPath, ["add", "clean.txt"]);
  git(repoPath, ["commit", "-qm", "clean"]);
  const cleanSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
  git(repoPath, ["checkout", "-q", "main"]);
  const clean = S.createIssue(repo.id, "pull", "Clean", "", "me");
  S.createPull(clean.id, "clean", "main", cleanSha, null);
  S.createReview(clean.id, "reviewer", "PASS", "passed", cleanSha);

  await svc.notifications.sweepMergeReady();
  await svc.notifications.sweepMergeReady();
  let notifications = (await svc.notifications.list({ limit: 100 })).filter(
    (n: any) => n.repo.name === "me/notify-transitions",
  );
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    kind: "merge_ready",
    title: "Ready to merge",
    resource: { kind: "pull", number: clean.number },
  });

  git(repoPath, ["checkout", "-q", "clean"]);
  writeFileSync(join(repoPath, "clean-again.txt"), "changed\n");
  git(repoPath, ["add", "clean-again.txt"]);
  git(repoPath, ["commit", "-qm", "change after pass"]);
  const changedSha = git(repoPath, ["rev-parse", "HEAD"]).stdout.trim();
  git(repoPath, ["checkout", "-q", "main"]);

  await svc.notifications.sweepMergeReady();
  notifications = (await svc.notifications.list({ limit: 100 })).filter(
    (n: any) => n.repo.name === "me/notify-transitions",
  );
  expect(notifications).toHaveLength(1);

  S.createReview(clean.id, "reviewer", "PASS", "passed again", changedSha);
  await svc.notifications.sweepMergeReady();
  await svc.notifications.sweepMergeReady();
  notifications = (await svc.notifications.list({ limit: 100 })).filter(
    (n: any) => n.repo.name === "me/notify-transitions",
  );
  expect(notifications).toHaveLength(2);
}, 15_000);

test("read marks a notification without removing it from the persisted list", async () => {
  const [notification] = await svc.notifications.list({ limit: 1 });
  const before = (await svc.notifications.unreadCount()).count;

  const read = svc.notifications.read(notification.id, "web-session");

  expect(read.read_at).toEqual(expect.any(String));
  expect((await svc.notifications.unreadCount()).count).toBe(before - 1);
  expect(
    (await svc.notifications.list({ limit: 20 })).map((n: any) => n.id),
  ).toContain(notification.id);
});

test("send creates an agent-triggered notification", async () => {
  const before = (await svc.notifications.unreadCount()).count;
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
  expect((await svc.notifications.unreadCount()).count).toBe(before + 1);
});

test("unread-only list returns more than the normal page limit", async () => {
  const repoPath = initGitRepo("lh-notifications-unread-list-");
  await svc.repos.create({ path: repoPath, name: "me/notify-unread-list" });
  for (let id = 1; id <= 101; id += 1) {
    svc.notifications.send("me/notify-unread-list", {
      kind: "human_attention",
      title: `Notification ${id}`,
      body: "Needs attention.",
      resourceKind: "repo",
      sourceKey: `unread-list:${id}`,
    });
  }

  const notifications = await svc.notifications.list({ unreadOnly: true });

  expect(
    notifications.filter(
      (notification: any) => notification.repo.name === "me/notify-unread-list",
    ),
  ).toHaveLength(101);
});

test("backfill defers reversible hidden states but ignores merged PR signals", async () => {
  const repo = S.getRepo("me", "notify")!;
  const closed = S.createIssue(repo.id, "pull", "Closed PR", "", "me");
  S.createPull(closed.id, "closed", "main", "sha-closed", null);
  const archived = S.createIssue(repo.id, "pull", "Archived PR", "", "me");
  S.createPull(archived.id, "archived", "main", "sha-archived", null);
  const merged = S.createIssue(repo.id, "pull", "Merged PR", "", "me");
  S.createPull(merged.id, "merged", "main", "sha-merged", null);

  S.emitEvent(repo.id, "dev.cost_stopped", "lh-worker", {
    number: closed.number,
    session_id: "session-closed",
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
  S.setMerged(merged.id, "merged-sha", "merge");

  let notifications = await svc.notifications.list({ limit: 100 });

  expect(
    notifications.some(
      (n: any) =>
        n.repo.name === "me/notify" &&
        n.resource.kind === "pull" &&
        n.resource.number === closed.number,
    ),
  ).toBe(false);
  expect(
    notifications.some(
      (n: any) =>
        n.repo.name === "me/notify" &&
        n.resource.kind === "pull" &&
        n.resource.number === merged.number,
    ),
  ).toBe(false);

  S.setRepoArchived(repo.id, false);
  S.updateIssue(closed.id, { state: "open" });

  notifications = await svc.notifications.list({ limit: 100 });
  expect(
    notifications.some(
      (n: any) =>
        n.repo.name === "me/notify" &&
        n.resource.kind === "pull" &&
        n.resource.number === closed.number,
    ),
  ).toBe(true);
  expect(
    notifications.some(
      (n: any) =>
        n.repo.name === "me/notify" &&
        n.resource.kind === "pull" &&
        n.resource.number === archived.number,
    ),
  ).toBe(true);
  expect(
    notifications.some(
      (n: any) =>
        n.repo.name === "me/notify" &&
        n.resource.kind === "pull" &&
        n.resource.number === merged.number,
    ),
  ).toBe(false);
});

test("human-attention backfill follows the latest substantive review", async () => {
  const repo = S.getRepo("me", "notify")!;
  const resolved = S.createIssue(repo.id, "pull", "Resolved PR", "", "me");
  S.createPull(resolved.id, "resolved", "main", "sha-resolved", null);
  S.createReview(resolved.id, "reviewer", "REQUEST_CHANGES", "fix this");
  S.createReview(resolved.id, "reviewer", "PASS", "fixed");

  let notifications = await svc.notifications.list({ limit: 100 });
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
  notifications = await svc.notifications.list({ limit: 100 });
  expect(
    notifications.filter(
      (n: any) =>
        n.kind === "human_attention" &&
        n.resource.kind === "pull" &&
        n.resource.number === changed.number,
    ),
  ).toHaveLength(1);

  S.createReview(changed.id, "reviewer", "PASS", "fixed");
  await svc.notifications.unreadCount();
  S.createReview(changed.id, "reviewer", "REQUEST_CHANGES", "again");

  notifications = await svc.notifications.list({ limit: 100 });
  expect(
    notifications.filter(
      (n: any) =>
        n.kind === "human_attention" &&
        n.resource.kind === "pull" &&
        n.resource.number === changed.number,
    ),
  ).toHaveLength(2);
});

test("human-attention backfill follows the latest substantive review per topic", async () => {
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

  const notifications = await svc.notifications.list({ limit: 100 });

  expect(
    notifications.filter(
      (n: any) =>
        n.kind === "human_attention" &&
        n.resource.kind === "pull" &&
        n.resource.number === pr.number,
    ),
  ).toHaveLength(1);
});

test("backfill creates a notification for each repeated cost stop event", async () => {
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

  const notifications = await svc.notifications.list({ limit: 100 });

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

test("readAll marks every visible notification read and returns the count", async () => {
  const repoPath = initGitRepo("lh-notifications-readall-repo-");
  await svc.repos.create({ path: repoPath, name: "me/notify-readall" });
  for (let i = 0; i < 3; i++) {
    svc.notifications.send("me/notify-readall", {
      kind: "human_attention",
      title: `Alert ${i}`,
      body: `Body ${i}.`,
      resourceKind: "repo",
      sourceKey: `cli-test:readall-${i}`,
    });
  }
  const before = (await svc.notifications.unreadCount()).count;
  expect(before).toBeGreaterThanOrEqual(3);

  const result = await svc.notifications.readAll("web-session");

  expect(result.count).toBe(before);
  expect((await svc.notifications.unreadCount()).count).toBe(0);
  // Already-read notifications are a no-op on a second call.
  expect((await svc.notifications.readAll("web-session")).count).toBe(0);
});

test("repo removal deletes persisted notifications before deleting the repo", async () => {
  const repoPath = initGitRepo("lh-notifications-remove-repo-");
  await svc.repos.create({ path: repoPath, name: "me/notify-remove" });
  const repo = S.getRepo("me", "notify-remove")!;
  const pull = S.createIssue(repo.id, "pull", "Tracked state", "", "me");
  S.createPull(pull.id, "main", "main", null, null);
  await svc.notifications.sweepMergeReady();
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

test("send rejects the retired implementation_done kind", () => {
  expect(() =>
    svc.notifications.send("me/notify", {
      kind: "implementation_done",
      title: "Implementation complete",
      body: "Ready for review.",
      resourceKind: "repo",
    }),
  ).toThrow("kind must be merge_ready, over_budget, or human_attention");
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
