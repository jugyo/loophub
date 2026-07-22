import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";

// Backward compatibility: hand-build an old schema with node:sqlite, THEN import core so its
// import-time migrations run against existing tables. This covers both the retired
// pulls.session_id pointer (#316) and newer additive Workflow run columns.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;

const HOME = mkdtempSync(join(tmpdir(), "lh-dbmig-"));
const DB_PATH = join(HOME, "test.db");
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = DB_PATH;

let D: typeof import("./db.ts");
let S: typeof import("./store.ts");

beforeAll(async () => {
  // Seed an old-schema DB: pulls still has session_id (a pre-#316 1:1 dev-session pointer), the
  // session is NOT yet in session_links and its kind is still NULL (pre-#298 state). The migration
  // must backfill the link, stamp kind='dev', and drop the column.
  const seed = new DatabaseSync(DB_PATH);
  seed.exec(`
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, owner TEXT NOT NULL, local_path TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main', created_at TEXT NOT NULL
    );
    CREATE TABLE issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id),
      number INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', author TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (repo_id, number)
    );
    CREATE TABLE pulls (
      issue_id INTEGER PRIMARY KEY REFERENCES issues(id), head_ref TEXT NOT NULL,
      base_ref TEXT NOT NULL, head_sha TEXT, merged INTEGER NOT NULL DEFAULT 0,
      merged_at TEXT, merge_commit_sha TEXT, merge_method TEXT,
      linked_issue_id INTEGER REFERENCES issues(id),
      session_id TEXT REFERENCES agent_sessions(id)
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, external_session TEXT NOT NULL,
      name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (agent, external_session)
    );
    CREATE TABLE issue_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (repo_id, name)
    );
    CREATE TABLE issue_group_members (
      group_id INTEGER NOT NULL REFERENCES issue_groups(id),
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      position INTEGER NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (group_id, issue_id)
    );
    CREATE TABLE workflow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id INTEGER,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      issue_number INTEGER NOT NULL,
      pr_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      current_step TEXT NOT NULL,
      rework_count INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT,
      step_sessions_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_issue_groups_repo ON issue_groups(repo_id);
    CREATE INDEX idx_issue_group_members_issue ON issue_group_members(issue_id);
    INSERT INTO repos (id, full_name, name, owner, local_path, created_at)
      VALUES (1, 'me/proj', 'proj', 'me', '/tmp/proj', 't0');
    INSERT INTO issues (id, repo_id, number, kind, title, author, created_at, updated_at)
      VALUES (10, 1, 7, 'pull', 'impl', 'bot', 't1', 't1');
    -- Preserve a session written by the retired pre-Workflow lh-dev launcher during migration.
    INSERT INTO agent_sessions (id, agent, external_session, name, created_at, updated_at)
      VALUES ('11111111-0000-0000-0000-000000000001', 'lh-dev',
              '11111111-0000-0000-0000-000000000001', 'dev', 't1', 't1');
    INSERT INTO pulls (issue_id, head_ref, base_ref, linked_issue_id, session_id)
      VALUES (10, 'loophub/issue-7', 'main', NULL, '11111111-0000-0000-0000-000000000001');
    INSERT INTO issue_groups (id, repo_id, name, created_at, updated_at)
      VALUES (20, 1, 'obsolete', 't1', 't1');
    INSERT INTO issue_group_members (group_id, issue_id, position, added_at)
      VALUES (20, 10, 0, 't1');
    INSERT INTO workflow_runs
      (id, workflow_id, repo_id, issue_number, pr_number, status, current_step,
       parent_session_id, created_at, updated_at)
      VALUES (30, NULL, 1, 6, 7, 'running', 'execute', NULL, 't1', 't1');
  `);
  seed.close();

  D = await import("./db.ts"); // import-time migration runs here
  S = await import("./store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("pulls.session_id is dropped after migration", () => {
  const cols = (
    D.db.query("PRAGMA table_info(pulls)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).not.toContain("session_id");
  expect(cols).toContain("base_sha");
  expect(cols).toContain("head_pending_creation");
  expect(S.getPull(10)?.base_sha).toBeNull();
  expect(S.getPull(10)?.head_pending_creation).toBe(0);
});

test("workflow runs gain active child, watcher cursor, and cost limit columns", () => {
  const cols = (
    D.db.query("PRAGMA table_info(workflow_runs)").all() as { name: string }[]
  ).map((c) => c.name);
  expect(cols).toContain("active_step");
  expect(cols).toContain("active_session_id");
  expect(cols).toContain("contract_language");
  expect(S.getWorkflowRun(30)?.contract_language).toBe("en");
  expect(cols).not.toContain("event_ack_cursor");
  expect(cols).not.toContain("event_delivered_cursor");
  expect(cols).toContain("cost_increment_usd");
  expect(cols).toContain("cost_limit_usd");
});

test("workflow runs gain durable event-effect receipts", () => {
  const cols = (
    D.db.query("PRAGMA table_info(workflow_event_effects)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(cols).toEqual([
    "run_id",
    "event_id",
    "effect",
    "status",
    "created_at",
    "updated_at",
  ]);
});

test("the legacy dev-session pointer survives in session_links (resume anchor preserved)", () => {
  // The pre-#316 pulls.session_id value is now derivable from session_links as the PR's primary dev
  // session — the exact value `lh resume`/retro resolved before the column was dropped.
  expect(S.primaryDevSessionForPull(10)).toBe(
    "11111111-0000-0000-0000-000000000001",
  );
});

test("the migrated session is stamped kind='dev'", () => {
  const s = S.getAgentSession("11111111-0000-0000-0000-000000000001")!;
  expect(s.kind).toBe("dev");
});

test("retired issue group tables, data, and indexes are dropped", () => {
  const names = (
    D.db
      .query(
        `SELECT name FROM sqlite_schema
         WHERE name IN (
           'issue_groups',
           'issue_group_members',
           'idx_issue_groups_repo',
           'idx_issue_group_members_issue'
         )`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  expect(names).toEqual([]);
});
