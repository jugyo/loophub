import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;
const HOME = mkdtempSync(join(tmpdir(), "lh-herdr-panes-migrate-"));
const DB_PATH = join(HOME, "legacy.db");
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = DB_PATH;

let S: typeof import("./store.ts");
let D: typeof import("./db.ts");

beforeAll(async () => {
  const seed = new DatabaseSync(DB_PATH);
  seed.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      local_path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      created_at TEXT NOT NULL
    );
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (repo_id, number)
    );
    CREATE TABLE issue_herdr_panes (
      launch_id TEXT PRIMARY KEY,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      issue_id INTEGER REFERENCES issues(id),
      pane_id TEXT,
      session_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO repos
      (id, full_name, name, owner, local_path, default_branch, created_at)
    VALUES (1, 'me/legacy', 'legacy', 'me', '/tmp/legacy', 'main', '2026-01-01T00:00:00Z');
    INSERT INTO issues
      (id, repo_id, number, kind, title, author, created_at, updated_at)
    VALUES (7, 1, 3, 'issue', 'Legacy issue', 'me',
            '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
    INSERT INTO issue_herdr_panes
      (launch_id, repo_id, issue_id, pane_id, session_name, created_at, updated_at)
    VALUES ('legacy-launch', 1, 7, 'w3:p4', 'me-legacy-12345678',
            '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z');
  `);
  seed.close();

  D = await import("./db.ts");
  S = await import("./store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("legacy issue pane data migrates to the generic pane registry", () => {
  expect(
    S.listHerdrPanesForResource({
      repoId: 1,
      resourceKind: "issue",
      resourceKey: "7",
    }),
  ).toEqual([
    expect.objectContaining({
      launch_id: "legacy-launch",
      pane_id: "w3:p4",
      session_name: "me-legacy-12345678",
      display_name: "New issue",
      origin: "issue-create",
      lifecycle_managed: 1,
      closed_at: null,
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-04T00:00:00Z",
    }),
  ]);
  expect(
    S.listHerdrPanesForResource({
      repoId: 1,
      resourceKind: "issue",
      resourceKey: "7",
      relationship: "filed-from",
    }),
  ).toHaveLength(1);
  expect(
    D.db
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issue_herdr_panes'`,
      )
      .get(),
  ).toBeNull();
  expect(
    S.listHerdrPaneClaimsForResource({
      repoId: 1,
      resourceKind: "issue",
      resourceKey: "7",
    }),
  ).toEqual([
    expect.objectContaining({
      purpose: "issue-create-lifecycle",
      created_at: "2026-01-03T00:00:00Z",
      released_at: null,
    }),
  ]);
});
