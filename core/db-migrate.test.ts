import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, beforeAll, expect, test } from "vitest";

// #316 backward-compat: an existing DB carrying the (now-retired) pulls.session_id pointer must have
// that attribution migrated into session_links BEFORE the column is dropped, so `lh resume`/retro
// keep resolving the PR's dev session. We simulate a pre-#316 DB by hand-building the old schema with
// node:sqlite directly, THEN importing core (which runs the import-time migration against it).
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
    INSERT INTO repos (id, full_name, name, owner, local_path, created_at)
      VALUES (1, 'me/proj', 'proj', 'me', '/tmp/proj', 't0');
    INSERT INTO issues (id, repo_id, number, kind, title, author, created_at, updated_at)
      VALUES (10, 1, 7, 'pull', 'impl', 'bot', 't1', 't1');
    INSERT INTO agent_sessions (id, agent, external_session, name, created_at, updated_at)
      VALUES ('11111111-0000-0000-0000-000000000001', 'lh-dev',
              '11111111-0000-0000-0000-000000000001', 'dev', 't1', 't1');
    INSERT INTO pulls (issue_id, head_ref, base_ref, linked_issue_id, session_id)
      VALUES (10, 'loophub/issue-7', 'main', NULL, '11111111-0000-0000-0000-000000000001');
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
  expect(S.getPull(10)?.base_sha).toBeNull();
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
