import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;

const HOME = mkdtempSync(join(tmpdir(), "lh-notification-kind-migrate-"));
const DB_PATH = join(HOME, "test.db");
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = DB_PATH;

let D: typeof import("./db.ts");

beforeAll(async () => {
  const seed = new DatabaseSync(DB_PATH);
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
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("notification kind migration removes retired alerts and accepts merge-ready alerts", () => {
  const rows = D.db
    .query(`SELECT kind FROM notifications ORDER BY id`)
    .all() as {
    kind: string;
  }[];
  expect(rows).toEqual([{ kind: "over_budget" }]);

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
  expect(() =>
    D.db.run(
      `INSERT INTO notifications
        (repo_id, kind, title, body, resource_kind, source_key, created_at)
       VALUES (1, 'implementation_done', 'Old', 'Old', 'repo', 'retired', 't4')`,
    ),
  ).toThrow();
});
