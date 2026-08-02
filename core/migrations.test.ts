import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";

// Hand-build an old-schema database with node:sqlite, THEN import core so its migrations run
// against existing tables. That import is the "first boot on an existing install" path: the ledger
// starts empty, every migration runs once against a partially-migrated schema, and the ids are
// recorded so later boots do nothing.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;

const HOME = mkdtempSync(join(tmpdir(), "lh-migrations-"));
const LEGACY_DB = join(HOME, "legacy.db");
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = LEGACY_DB;

let D: typeof import("./db.ts");
let M: typeof import("./migrations.ts");

beforeAll(async () => {
  const seed = new DatabaseSync(LEGACY_DB);
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
      base_ref TEXT NOT NULL, head_sha TEXT, draft INTEGER NOT NULL DEFAULT 1,
      merged INTEGER NOT NULL DEFAULT 0,
      merged_at TEXT, merge_commit_sha TEXT, merge_method TEXT,
      session_id TEXT REFERENCES agent_sessions(id)
    );
    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER NOT NULL REFERENCES issues(id),
      author TEXT NOT NULL, event TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE acceptance_criteria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL REFERENCES issues(id),
      ordinal INTEGER NOT NULL, text TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER REFERENCES repos(id), type TEXT NOT NULL,
      actor TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, external_session TEXT NOT NULL,
      name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (agent, external_session)
    );
    CREATE TABLE issue_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (repo_id, name)
    );
    INSERT INTO repos (id, full_name, name, owner, local_path, created_at)
      VALUES (1, 'me/proj', 'proj', 'me', '/tmp/proj', 't0');
    INSERT INTO issues (id, repo_id, number, kind, state, title, author, created_at, updated_at)
      VALUES (10, 1, 7, 'pull', 'closed', 'impl', 'bot', 't1', 't1');
    INSERT INTO issues (id, repo_id, number, kind, state, title, author, created_at, updated_at)
      VALUES (11, 1, 8, 'issue', 'open', 'rubric', 'bot', 't1', 't1');
    INSERT INTO acceptance_criteria (id, issue_id, ordinal, text, created_at)
      VALUES (31, 11, 2, 'created first', 't1'),
             (32, 11, 1, 'created second', 't2');
    INSERT INTO agent_sessions (id, agent, external_session, name, created_at, updated_at)
      VALUES ('sess-1', 'lh-dev', 'sess-1', 'dev', 't1', 't1');
    INSERT INTO pulls (issue_id, head_ref, base_ref, session_id)
      VALUES (10, 'loophub/issue-7', 'main', 'sess-1');
    INSERT INTO reviews (issue_id, author, event, created_at)
      VALUES (10, 'reviewer', 'APPROVE', 't2');
    INSERT INTO events (repo_id, type, actor, payload, created_at)
      VALUES (1, 'issue.opened', 'bot', '{"number": 9}', 't2');
  `);
  seed.close();

  D = await import("./db.ts"); // migrations run here
  M = await import("./migrations.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function appliedIds(db: import("./db.ts").Db): string[] {
  return (
    db.query("SELECT id FROM schema_migrations ORDER BY id").all() as {
      id: string;
    }[]
  ).map((row) => row.id);
}

test("migration ids are unique and ordered by their numeric prefix", () => {
  const ids = M.MIGRATIONS.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort()).toEqual(ids);
});

test("first boot on an existing database seeds the ledger with every migration", () => {
  expect(appliedIds(D.db)).toEqual([...M.MIGRATIONS.map((m) => m.id)].sort());
});

test("a later boot re-runs nothing", () => {
  expect(M.runMigrations(D.db)).toEqual([]);
});

test("the one-time data migrations converged instead of running on every boot", () => {
  // Each of these is a data rewrite the retired tryExec list replayed on every process start.
  expect(D.db.query("SELECT event FROM reviews WHERE id = 1").get()).toEqual({
    event: "PASS",
  });
  expect(
    D.db
      .query("SELECT last_number FROM repo_number_sequences WHERE repo_id = 1")
      .get(),
  ).toEqual({ last_number: 9 });
  expect(
    D.db.query("SELECT closed_at FROM issues WHERE id = 10").get(),
  ).toEqual({ closed_at: "t1" });
  expect(
    D.db
      .query("SELECT last_id FROM notification_cursors WHERE scope = 'events'")
      .get(),
  ).toEqual({ last_id: 1 });
  expect(
    D.db
      .query("SELECT id, number, ordinal FROM acceptance_criteria ORDER BY id")
      .all(),
  ).toEqual([
    { id: 31, number: 1, ordinal: 2 },
    { id: 32, number: 2, ordinal: 1 },
  ]);
});

test("comment author backfill uses unambiguous session identities", () => {
  D.db.exec(`
    INSERT INTO agent_sessions
      (id, agent, external_session, name, created_at, updated_at)
    VALUES
      ('human-commenter', 'me', 'human-commenter', 'person', 't3', 't3'),
      ('human-collision', 'me', 'human-collision', 'shared', 't3', 't3'),
      ('agent-collision', 'codex', 'agent-collision', 'shared', 't3', 't3');
    INSERT INTO comments
      (issue_id, author, author_type, body, created_at, updated_at)
    VALUES
      (10, 'dev', 'system', 'historical agent comment', 't3', 't3'),
      (10, 'shared', 'agent', 'classified agent comment', 't3', 't3'),
      (10, 'person', 'human', 'classified human comment', 't3', 't3');
    INSERT INTO review_comments
      (issue_id, review_id, author, author_type, body, path, created_at)
    VALUES
      (10, 1, 'dev', 'system', 'agent', 'a.ts', 't3'),
      (10, 1, 'person', 'system', 'human', 'a.ts', 't3'),
      (10, 1, 'shared', 'system', 'ambiguous', 'a.ts', 't3');
    INSERT INTO diff_feedback_threads
      (id, issue_id, pr_number, base_sha, head_sha, path, side, start_line,
       end_line, created_by, created_by_type, created_at)
    VALUES
      (71, 10, 7, 'base', 'head', 'a.ts', 'RIGHT', 1, 1, 'dev', 'system', 't3');
    INSERT INTO diff_feedback_messages
      (thread_id, author, author_type, body, created_at)
    VALUES
      (71, 'person', 'system', 'human', 't3'),
      (71, 'shared', 'system', 'ambiguous', 't3');
    INSERT INTO reviews
      (issue_id, author, author_type, event, body, model, created_at)
    VALUES
      (10, 'dev', 'system', 'COMMENT', 'modeled agent', 'gpt-test', 't3'),
      (10, 'person', 'system', 'COMMENT', 'human', NULL, 't3'),
      (10, 'shared', 'agent', 'COMMENT', 'classified agent', NULL, 't3');
  `);

  M.MIGRATIONS.find(
    (migration) => migration.id === "061-comment-author-types",
  )?.run(D.db);
  M.MIGRATIONS.find(
    (migration) => migration.id === "062-review-author-types",
  )?.run(D.db);

  expect(
    D.db.query(`SELECT author, author_type FROM comments ORDER BY id`).all(),
  ).toEqual([
    { author: "dev", author_type: "agent" },
    { author: "shared", author_type: "agent" },
    { author: "person", author_type: "human" },
  ]);
  expect(
    D.db
      .query(`SELECT author, author_type FROM review_comments ORDER BY id`)
      .all(),
  ).toEqual([
    { author: "dev", author_type: "agent" },
    { author: "person", author_type: "human" },
    { author: "shared", author_type: "system" },
  ]);
  expect(
    D.db
      .query(
        `SELECT created_by, created_by_type FROM diff_feedback_threads WHERE id = 71`,
      )
      .get(),
  ).toEqual({ created_by: "dev", created_by_type: "agent" });
  expect(
    D.db
      .query(
        `SELECT author, author_type FROM diff_feedback_messages WHERE thread_id = 71 ORDER BY id`,
      )
      .all(),
  ).toEqual([
    { author: "person", author_type: "human" },
    { author: "shared", author_type: "system" },
  ]);
  expect(
    D.db
      .query(`SELECT author, author_type FROM reviews WHERE id > 1 ORDER BY id`)
      .all(),
  ).toEqual([
    { author: "dev", author_type: "agent" },
    { author: "person", author_type: "human" },
    { author: "shared", author_type: "agent" },
  ]);
});

test("readiness confirmation backfill treats same-timestamp receipts as ambiguous", () => {
  D.db.exec(`
    INSERT INTO workflow_runs
      (id, workflow_id, repo_id, issue_number, pr_number, status, current_step,
       parent_ready_at, parent_ready_confirmed, cost_increment_usd, cost_limit_usd,
       created_at, updated_at)
    VALUES
      (901, NULL, 1, 901, 902, 'running', 'execute', 't5', 0, 5, 5, 't4', 't5'),
      (902, NULL, 1, 903, 904, 'running', 'execute', 't5', 0, 5, 5, 't4', 't5');
    INSERT INTO events (id, repo_id, type, actor, payload, created_at)
    VALUES
      (901, 1, 'workflow_run.started', 'me', '{"id":901}', 't4'),
      (902, 1, 'workflow_run.started', 'me', '{"id":902}', 't4');
    INSERT INTO workflow_event_effects
      (run_id, event_id, effect, status, created_at, updated_at)
    VALUES
      (901, 901, 'workflow.instruction:ambiguous', 'completed', 't5', 't5'),
      (902, 902, 'workflow.instruction:safe', 'completed', 't6', 't6');
  `);

  M.MIGRATIONS.find(
    (migration) => migration.id === "058-workflow-runs-parent-ready-confirmed",
  )?.run(D.db);

  expect(
    D.db
      .query(
        `SELECT id, parent_ready_confirmed FROM workflow_runs
         WHERE id IN (901, 902) ORDER BY id`,
      )
      .all(),
  ).toEqual([
    { id: 901, parent_ready_confirmed: 0 },
    { id: 902, parent_ready_confirmed: 1 },
  ]);
});

// Columns whose migrated shape legitimately differs from the fresh schema. SQLite cannot add a
// NOT NULL column without a default, and there is no defensible default cost budget to invent for
// runs created before the columns existed, so an upgraded database keeps them nullable.
const NULLABILITY_EXCEPTIONS = new Set([
  "workflow_runs.cost_increment_usd",
  "workflow_runs.cost_limit_usd",
]);

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexInfo {
  name: string;
  unique: number;
  partial: number;
}

// Tables and indexes with the details that matter for equivalence. Column *order* is deliberately
// normalized away: ALTER TABLE ADD COLUMN appends, so a migrated database orders columns by the
// history that produced it while a fresh one follows the schema literal.
function structure(db: import("./db.ts").Db): Record<string, unknown> {
  const tables = (
    db
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

  const out: Record<string, unknown> = {};
  for (const table of tables) {
    const columns = (
      db.query(`PRAGMA table_info(${table})`).all() as ColumnInfo[]
    )
      .map((c) => ({
        name: c.name,
        type: c.type,
        notnull: NULLABILITY_EXCEPTIONS.has(`${table}.${c.name}`)
          ? null
          : c.notnull,
        dflt_value: c.dflt_value,
        pk: c.pk,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const indexes = (
      db.query(`PRAGMA index_list(${table})`).all() as IndexInfo[]
    )
      .map((i) => ({
        name: i.name,
        unique: i.unique,
        partial: i.partial,
        columns: (
          db.query(`PRAGMA index_info(${i.name})`).all() as {
            name: string | null;
          }[]
        ).map((c) => c.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    out[table] = { columns, indexes };
  }
  return out;
}

test("a database migrated from an old schema ends up structurally identical to a fresh one", () => {
  const fresh = D.openDb(join(HOME, "fresh.db"));
  expect(structure(D.db)).toEqual(structure(fresh));
});

test("a failing migration throws, rolls back, and stays out of the ledger", () => {
  const db = D.openDb(join(HOME, "failing.db"));
  const before = appliedIds(db);

  expect(() =>
    M.runMigrations(db, [
      {
        id: "test-bad-sql",
        run: (target) => {
          target.exec(
            "INSERT INTO repos (full_name, name, owner, local_path, created_at) VALUES ('a/b', 'b', 'a', '/tmp/b', 't0')",
          );
          target.exec("ALTER TABLE no_such_table ADD COLUMN x TEXT");
        },
      },
    ]),
  ).toThrow(/test-bad-sql/);

  expect(appliedIds(db)).toEqual(before);
  // The partial work is gone: the migration and its ledger row share one transaction.
  expect(db.query("SELECT COUNT(*) AS n FROM repos").get()).toEqual({ n: 0 });
});
