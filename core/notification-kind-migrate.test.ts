import type * as SqliteNS from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const { Database } = createRequire(import.meta.url)(
  "bun:sqlite",
) as typeof SqliteNS;

const HOME = mkdtempSync(join(tmpdir(), "lh-notification-kind-migrate-"));
const DB_PATH = join(HOME, "test.db");
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = DB_PATH;

let D: typeof import("./db.ts");
let S: typeof import("./store.ts");

beforeAll(async () => {
  const seed = new Database(DB_PATH);
  seed.exec(`
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, owner TEXT NOT NULL, local_path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main', created_at TEXT NOT NULL
    );
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      kind TEXT NOT NULL
        CHECK (kind IN ('implementation_done', 'over_budget', 'human_attention')),
      title TEXT NOT NULL, body TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('issue', 'pull', 'repo')),
      resource_number INTEGER, source_key TEXT NOT NULL UNIQUE,
      herdr_pane_id TEXT, read_at TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO repos (id, full_name, name, owner, local_path, created_at)
      VALUES (1, 'me/proj', 'proj', 'me', '/tmp/proj', 't0');
    INSERT INTO notifications
      (repo_id, kind, title, body, resource_kind, source_key, created_at)
    VALUES
      (1, 'implementation_done', 'Implementation complete', 'Old signal', 'repo', 'old', 't1'),
      (1, 'over_budget', 'Over budget', 'Keep this', 'repo', 'cost', 't2');
  `);
  seed.close();

  D = await import("./db.ts");
  S = await import("./store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("notification kind migrations drop retired alerts, keep rows, and remove the kind CHECK", () => {
  const rows = D.db
    .query(`SELECT kind FROM notifications ORDER BY id`)
    .all() as {
    kind: string;
  }[];
  // 006 drops implementation_done; later rebuilds keep remaining rows (over_budget).
  expect(rows).toEqual([{ kind: "over_budget" }]);

  const table = D.db
    .query(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`,
    )
    .get() as { sql: string };
  // #21: kind is free-form at the SQL layer; allowlist lives in code.
  expect(table.sql).not.toContain("CHECK (kind IN");

  expect(() =>
    D.db.run(
      `INSERT INTO notifications
        (repo_id, kind, title, body, resource_kind, source_key, created_at)
       VALUES (1, 'merge_ready', 'Ready to merge', 'Ready', 'repo', 'ready', 't3')`,
    ),
  ).not.toThrow();
  expect(() =>
    D.db.run(
      `INSERT INTO notifications
        (repo_id, kind, title, body, resource_kind, source_key, created_at)
       VALUES (1, 'agent_comment', 'Agent comment', 'Hi', 'pull', 'agent', 't3b')`,
    ),
  ).not.toThrow();
  // Without a kind CHECK, raw SQL can store values the product no longer uses; createNotification
  // still rejects them. Proves the migration dropped the constraint rather than widening it.
  expect(() =>
    D.db.run(
      `INSERT INTO notifications
        (repo_id, kind, title, body, resource_kind, source_key, created_at)
       VALUES (1, 'implementation_done', 'Old', 'Old', 'repo', 'retired', 't4')`,
    ),
  ).not.toThrow();

  const after = D.db
    .query(`SELECT kind FROM notifications ORDER BY id`)
    .all() as { kind: string }[];
  expect(after.map((r) => r.kind)).toEqual([
    "over_budget",
    "merge_ready",
    "agent_comment",
    "implementation_done",
  ]);
});

test("createNotification and assert helpers share the single kind allowlist", () => {
  expect([...S.NOTIFICATION_KINDS]).toEqual([
    "merge_ready",
    "over_budget",
    "human_attention",
    "agent_comment",
    "github_pr_linked",
  ]);
  expect(S.isNotificationKind("agent_comment")).toBe(true);
  expect(S.isNotificationKind("implementation_done")).toBe(false);
  expect(S.notificationKindAllowlistMessage()).toBe(
    "merge_ready, over_budget, human_attention, agent_comment, or github_pr_linked",
  );

  const expected = `kind must be ${S.notificationKindAllowlistMessage()}`;
  expect(() => S.assertNotificationKind("implementation_done")).toThrow(
    expected,
  );

  expect(() =>
    S.createNotification({
      repoId: 1,
      kind: "implementation_done" as unknown as import("./store.ts").NotificationKind,
      title: "Retired",
      body: "Should not insert via store.",
      resourceKind: "repo",
      sourceKey: "store-test:retired-kind",
    }),
  ).toThrow(expected);

  // Allowed kinds still insert through the store path.
  const row = S.createNotification({
    repoId: 1,
    kind: "human_attention",
    title: "Needs eyes",
    body: "Please look.",
    resourceKind: "repo",
    sourceKey: "store-test:human-attention",
  });
  expect(row).toMatchObject({ kind: "human_attention", title: "Needs eyes" });
});
