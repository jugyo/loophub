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

test("migration ID は一意で append-only の宣言順を維持する", () => {
  const ids = M.MIGRATIONS.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.slice(0, 3)).toEqual([
    "001-seed-repo-number-sequences",
    "002-drop-retired-issue-groups",
    "003-create-issue-search-grams",
  ]);
  expect(ids.at(-1)).toBe("20260818231634-pr-change-maps-document");
  expect(ids).toContain("088-workflow-runs-manifest-version");
});

test("新しい migration ID は UTC timestamp と説明名を使う", () => {
  expect(
    M.createMigrationId("add-foo-index", new Date("2026-08-14T05:45:17.999Z")),
  ).toBe("20260814054517-add-foo-index");
});

test("旧形式と timestamp 形式の migration ID は同じ ledger で宣言順に扱える", () => {
  const db = D.openDb(join(HOME, "mixed.db"));
  const ran: string[] = [];
  expect(
    M.runMigrations(db, [
      { id: "001-existing-step", run: () => ran.push("old") },
      { id: "20260814054517-add-foo-index", run: () => ran.push("new") },
    ]),
  ).toEqual(["001-existing-step", "20260814054517-add-foo-index"]);
  expect(ran).toEqual(["old", "new"]);
  expect(
    db
      .query(
        "SELECT id FROM schema_migrations WHERE id IN (?, ?) ORDER BY rowid",
      )
      .all("001-existing-step", "20260814054517-add-foo-index"),
  ).toEqual([
    { id: "001-existing-step" },
    { id: "20260814054517-add-foo-index" },
  ]);
  expect(
    M.runMigrations(db, [
      { id: "001-existing-step", run: () => ran.push("again") },
      { id: "20260814054517-add-foo-index", run: () => ran.push("again") },
    ]),
  ).toEqual([]);
  expect(ran).toEqual(["old", "new"]);
});

test("重複・不正な migration ID は実行前に失敗する", () => {
  const db = D.openDb(join(HOME, "invalid-ids.db"));
  const ran: string[] = [];
  expect(() =>
    M.runMigrations(db, [
      { id: "20260814054517-add-foo-index", run: () => ran.push("first") },
      { id: "20260814054517-add-foo-index", run: () => ran.push("duplicate") },
    ]),
  ).toThrow(/migration ID が重複しています: 20260814054517-add-foo-index/);
  expect(ran).toEqual([]);
  expect(() =>
    M.runMigrations(db, [
      { id: "not-a-valid-id", run: () => ran.push("invalid") },
    ]),
  ).toThrow(/migration ID が不正です: not-a-valid-id/);
  expect(ran).toEqual([]);
  expect(() =>
    M.runMigrations(db, [
      { id: "12-short-prefix", run: () => ran.push("short") },
    ]),
  ).toThrow(/migration ID が不正です: 12-short-prefix/);
  expect(ran).toEqual([]);
  expect(() =>
    M.runMigrations(db, [
      { id: "1234-long-prefix", run: () => ran.push("long") },
    ]),
  ).toThrow(/migration ID が不正です: 1234-long-prefix/);
  expect(ran).toEqual([]);
});

test("first boot on an existing database seeds the ledger with every migration", () => {
  expect(appliedIds(D.db)).toEqual([...M.MIGRATIONS.map((m) => m.id)].sort());
  expect(
    D.db
      .query(
        "SELECT parent_issue_id, sub_issue_ordinal FROM issues ORDER BY id",
      )
      .all(),
  ).toEqual([
    { parent_issue_id: null, sub_issue_ordinal: null },
    { parent_issue_id: null, sub_issue_ordinal: null },
  ]);
});

test("a later boot re-runs nothing", () => {
  expect(M.runMigrations(D.db)).toEqual([]);
});

test("不正なレビュー head SHA は無害化し、有効な値は保持する", () => {
  D.db.exec(`
    INSERT INTO reviews (issue_id, author, author_type, event, body, head_sha, created_at)
    VALUES
      (10, 'bad-length', 'agent', 'COMMENT', '', 'a', 't3'),
      (10, 'bad-hex', 'agent', 'COMMENT', '', 'g' || printf('%040d', 0), 't3'),
      (10, 'valid', 'agent', 'COMMENT', '', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 't3');
  `);
  const migration = M.MIGRATIONS.find(
    (candidate) => candidate.id === "20260815194735-invalid-review-head-shas",
  );
  if (!migration)
    throw new Error("invalid review head SHA migration not found");
  migration.run(D.db);

  expect(
    D.db
      .query("SELECT author, head_sha FROM reviews WHERE id > 1 ORDER BY id")
      .all(),
  ).toEqual([
    { author: "bad-length", head_sha: null },
    { author: "bad-hex", head_sha: null },
    {
      author: "valid",
      head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  ]);
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
    D.db.query("SELECT archived_at FROM pulls WHERE issue_id = 10").get(),
  ).toEqual({
    archived_at: null,
  });
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
      .query(
        `SELECT author, author_type FROM reviews
         WHERE author IN ('dev', 'person', 'shared') ORDER BY id`,
      )
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

test("repository workflow migration preserves ids, run references, and sequence", () => {
  const path = join(HOME, "workflow-scope.db");
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE repos (id INTEGER PRIMARY KEY);
    CREATE TABLE workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      execute_prompt TEXT NOT NULL DEFAULT '',
      verify_prompt TEXT NOT NULL DEFAULT '',
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE workflow_runs (
      id INTEGER PRIMARY KEY,
      workflow_id INTEGER REFERENCES workflows(id) ON DELETE SET NULL
    );
    INSERT INTO repos (id) VALUES (1);
    INSERT INTO workflows
      (id, name, description, execute_prompt, verify_prompt, created_at, updated_at)
    VALUES
      (7, 'Standard', '', '', '', 't1', 't1'),
      (9, 'Deleted', '', '', '', 't1', 't1');
    DELETE FROM workflows WHERE id = 9;
    INSERT INTO workflow_runs (id, workflow_id) VALUES (11, 7);
  `);

  const migration = M.MIGRATIONS.find(
    (migration) => migration.id === "067-repository-scoped-workflows",
  )!;
  migration.run({
    exec: db.exec.bind(db),
    query: db.prepare.bind(db),
    run: (sql: string, params: unknown[] = []) =>
      db.prepare(sql).run(...(params as SqliteNS.SQLInputValue[])),
  } as unknown as Parameters<typeof migration.run>[0]);

  expect(db.prepare(`SELECT id, repo_id, name FROM workflows`).get()).toEqual({
    id: 7,
    repo_id: null,
    name: "Standard",
  });
  expect(
    db.prepare(`SELECT workflow_id FROM workflow_runs WHERE id = 11`).get(),
  ).toEqual({ workflow_id: 7 });
  const inserted = db
    .prepare(
      `INSERT INTO workflows
        (name, description, execute_prompt, verify_prompt, created_at, updated_at)
       VALUES ('Next', '', '', '', 't2', 't2') RETURNING id`,
    )
    .get();
  expect(inserted).toEqual({ id: 10 });
  db.close();
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

test("the cache-read rate migration tolerates a database that holds only one rate table", () => {
  // The base schema stopped creating both tables, so this step now runs against databases that
  // carry neither — and against the narrow case of one without the other, since the two tables were
  // introduced at different times.
  const db = new DatabaseSync(join(HOME, "legacy-samples-only.db"));
  db.exec(`
    CREATE TABLE session_usage_samples (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL,
      total_tokens INTEGER NOT NULL,
      token_delta  INTEGER NOT NULL,
      observed_at  TEXT NOT NULL
    );
    INSERT INTO session_usage_samples (session_id, total_tokens, token_delta, observed_at)
    VALUES ('s1', 100, 0, '2040-07-09T11:31:00.000Z');
  `);
  const migration = M.MIGRATIONS.find(
    (candidate) => candidate.id === "065-session-usage-sample-cache-read",
  );
  if (!migration) throw new Error("cache-read rate migration not found");
  const adapter = {
    exec: db.exec.bind(db),
    query: db.prepare.bind(db),
    run: (sql: string, params: unknown[] = []) =>
      db.prepare(sql).run(...(params as SqliteNS.SQLInputValue[])),
  } as unknown as Parameters<(typeof migration)["run"]>[0];

  expect(() => migration.run(adapter)).not.toThrow();
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM session_usage_samples").get(),
  ).toEqual({ count: 0 });
  db.close();

  const empty = new DatabaseSync(join(HOME, "legacy-no-rate-tables.db"));
  expect(() =>
    migration.run({
      exec: empty.exec.bind(empty),
      query: empty.prepare.bind(empty),
      run: (sql: string, params: unknown[] = []) =>
        empty.prepare(sql).run(...(params as SqliteNS.SQLInputValue[])),
    } as unknown as Parameters<(typeof migration)["run"]>[0]),
  ).not.toThrow();
  empty.close();
});

test("the GitHub export status migration keeps every existing link as a linked export", () => {
  // Rebuilding github_pulls is what makes number/url nullable, so the risk is losing rows or their
  // bolted-on columns. Every pre-existing row is a recorded link by definition, so it must come out
  // 'linked' with its link intact and linked_at seeded from created_at.
  const db = new DatabaseSync(join(HOME, "legacy-github-pulls.db"));
  db.exec(`
    CREATE TABLE issues (id INTEGER PRIMARY KEY AUTOINCREMENT);
    INSERT INTO issues (id) VALUES (10);
    CREATE TABLE github_pulls (
      issue_id    INTEGER PRIMARY KEY REFERENCES issues(id),
      number      INTEGER NOT NULL,
      url         TEXT NOT NULL,
      branch      TEXT,
      created_by  TEXT,
      created_at  TEXT NOT NULL,
      github_merged INTEGER NOT NULL DEFAULT 0,
      github_merged_at TEXT,
      pushed_sha  TEXT
    );
    INSERT INTO github_pulls
      (issue_id, number, url, branch, created_by, created_at, github_merged, github_merged_at,
       pushed_sha)
    VALUES (10, 42, 'https://github.com/me/proj/pull/42', 'feat/x', 'agent', 't5', 1, 't6', 'abc');
  `);
  const migration = M.MIGRATIONS.find(
    (candidate) => candidate.id === "077-github-pulls-export-status",
  );
  if (!migration) throw new Error("github export status migration not found");
  const adapter = {
    exec: db.exec.bind(db),
    query: db.prepare.bind(db),
    run: (sql: string, params: unknown[] = []) =>
      db.prepare(sql).run(...(params as SqliteNS.SQLInputValue[])),
  } as unknown as Parameters<(typeof migration)["run"]>[0];

  migration.run(adapter);
  expect(db.prepare("SELECT * FROM github_pulls").all()).toEqual([
    {
      issue_id: 10,
      status: "linked",
      number: 42,
      url: "https://github.com/me/proj/pull/42",
      branch: "feat/x",
      created_by: "agent",
      created_at: "t5",
      linked_at: "t5",
      github_merged: 1,
      github_merged_at: "t6",
      pushed_sha: "abc",
    },
  ]);

  // Re-running is a no-op rather than a second rebuild that would wipe the table.
  migration.run(adapter);
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM github_pulls").get(),
  ).toEqual({ count: 1 });
  db.close();
});

test("the Workflow end migration freezes the best available terminal timestamp", () => {
  const db = new DatabaseSync(join(HOME, "legacy-workflow-ended-at.db"));
  db.exec(`
    CREATE TABLE workflow_runs (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO workflow_runs (id, status, updated_at) VALUES
      (1, 'running', 't1'),
      (2, 'completed', 't2'),
      (3, 'blocked', 't3');
  `);
  const migration = M.MIGRATIONS.find(
    (candidate) => candidate.id === "068-workflow-runs-ended-at",
  );
  if (!migration) throw new Error("Workflow end migration not found");
  migration.run({
    exec: db.exec.bind(db),
    query: db.prepare.bind(db),
    run: (sql: string, params: unknown[] = []) =>
      db.prepare(sql).run(...(params as SqliteNS.SQLInputValue[])),
  } as unknown as Parameters<(typeof migration)["run"]>[0]);

  expect(
    db.prepare("SELECT id, ended_at FROM workflow_runs ORDER BY id").all(),
  ).toEqual([
    { id: 1, ended_at: null },
    { id: 2, ended_at: "t2" },
    { id: 3, ended_at: "t3" },
  ]);
  db.close();
});

test("the diff feedback archive migration carries resolved threads over", () => {
  const db = new DatabaseSync(join(HOME, "legacy-diff-feedback-archive.db"));
  db.exec(`
    CREATE TABLE diff_feedback_threads (
      id INTEGER PRIMARY KEY,
      resolved_by TEXT,
      resolved_at TEXT
    );
    INSERT INTO diff_feedback_threads (id, resolved_by, resolved_at) VALUES
      (1, NULL, NULL),
      (2, 'me', 't2');
  `);
  const migration = M.MIGRATIONS.find(
    (candidate) => candidate.id === "071-diff-feedback-archive",
  );
  if (!migration) throw new Error("diff feedback archive migration not found");
  migration.run({
    exec: db.exec.bind(db),
    query: db.prepare.bind(db),
    run: (sql: string, params: unknown[] = []) =>
      db.prepare(sql).run(...(params as SqliteNS.SQLInputValue[])),
  } as unknown as Parameters<(typeof migration)["run"]>[0]);

  expect(
    db.prepare("SELECT * FROM diff_feedback_threads ORDER BY id").all(),
  ).toEqual([
    { id: 1, archived_at: null },
    { id: 2, archived_at: "t2" },
  ]);
  db.close();
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
