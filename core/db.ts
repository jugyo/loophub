import type * as SqliteNS from "node:sqlite";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "./config.ts";

// node:sqlite is an experimental builtin (Node 22.x, behind --experimental-sqlite).
// Load it through createRequire so bundler-based transformers (Vite/vitest) don't try
// to statically resolve the `node:sqlite` specifier as a package.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof SqliteNS;
type DatabaseSync = SqliteNS.DatabaseSync;
type StatementSync = SqliteNS.StatementSync;

// node:sqlite (DatabaseSync) exposes a different surface than bun:sqlite. The rest of
// core was written against the bun:sqlite shape (db.query(sql).get/all(...), db.run(sql, params[]),
// db.exec(sql)). This thin adapter re-creates that surface so store.ts et al. stay unchanged.
//
// Differences bridged here:
// - bun caches prepared statements per SQL string -> we cache via a Map.
// - bun's db.run takes (sql, paramsArray); node:sqlite has no db.run -> prepare(sql).run(...params).
// - undefined params throw in node:sqlite -> normalize undefined -> null (bun-compatible enough).

type Param = unknown;

function normalize(params: Param[]): Param[] {
  return params.map((p) => (p === undefined ? null : p));
}

interface BunStyleQuery {
  get(...params: Param[]): unknown;
  all(...params: Param[]): unknown[];
  run(...params: Param[]): void;
}

class Db {
  #raw: DatabaseSync;
  #cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.#raw = new DatabaseSync(path);
  }

  #prepare(sql: string): StatementSync {
    let stmt = this.#cache.get(sql);
    if (!stmt) {
      stmt = this.#raw.prepare(sql);
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql: string): void {
    this.#raw.exec(sql);
  }

  query(sql: string): BunStyleQuery {
    const stmt = this.#prepare(sql);
    return {
      get: (...params: Param[]) => stmt.get(...(normalize(params) as never[])) ?? null,
      all: (...params: Param[]) => stmt.all(...(normalize(params) as never[])),
      run: (...params: Param[]) => {
        stmt.run(...(normalize(params) as never[]));
      },
    };
  }

  run(sql: string, params: Param[] = []): void {
    this.#prepare(sql).run(...(normalize(params) as never[]));
  }
}

const path = dbPath();
mkdirSync(dirname(path), { recursive: true });

export const db = new Db(path);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  owner         TEXT NOT NULL,
  local_path    TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id),
  number      INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (repo_id, number)
);

CREATE TABLE IF NOT EXISTS pulls (
  issue_id        INTEGER PRIMARY KEY REFERENCES issues(id),
  head_ref        TEXT NOT NULL,
  base_ref        TEXT NOT NULL,
  head_sha        TEXT,
  merged          INTEGER NOT NULL DEFAULT 0,
  merged_at       TEXT,
  merge_commit_sha TEXT,
  merge_method    TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  author      TEXT NOT NULL,
  event       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  review_id   INTEGER REFERENCES reviews(id),
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  path        TEXT NOT NULL,
  line        INTEGER,
  side        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id   INTEGER NOT NULL REFERENCES repos(id),
  name      TEXT NOT NULL,
  color     TEXT,
  UNIQUE (repo_id, name)
);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id  INTEGER NOT NULL REFERENCES issues(id),
  label_id  INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY (issue_id, label_id)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER REFERENCES repos(id),
  type        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_repo_state ON issues(repo_id, state);
CREATE INDEX IF NOT EXISTS idx_comments_issue   ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_reviews_issue    ON reviews(issue_id);
CREATE INDEX IF NOT EXISTS idx_events_id        ON events(id);
CREATE INDEX IF NOT EXISTS idx_events_repo      ON events(repo_id, id);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                TEXT PRIMARY KEY,
  agent             TEXT NOT NULL,
  external_session  TEXT NOT NULL,
  name              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (agent, external_session)
);
`);

// 既存 DB 向けの軽量マイグレーション（カラムが既にあれば throw → 無視）
function tryExec(sql: string) {
  try {
    db.exec(sql);
  } catch {}
}

tryExec("ALTER TABLE pulls ADD COLUMN head_sha TEXT");
tryExec("ALTER TABLE review_comments ADD COLUMN review_id INTEGER");
tryExec("ALTER TABLE pulls ADD COLUMN linked_issue_id INTEGER REFERENCES issues(id)");
tryExec("CREATE INDEX IF NOT EXISTS idx_pulls_linked_issue ON pulls(linked_issue_id)");
tryExec("ALTER TABLE repos ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
tryExec("ALTER TABLE repos ADD COLUMN archived_at TEXT");
tryExec("ALTER TABLE issues ADD COLUMN assignee_session_id TEXT REFERENCES agent_sessions(id)");
tryExec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_assignee_session ON issues(assignee_session_id) WHERE assignee_session_id IS NOT NULL",
);
tryExec("ALTER TABLE pulls ADD COLUMN changes_addressed_at TEXT");
tryExec("ALTER TABLE pulls ADD COLUMN changes_addressed_by TEXT");
tryExec("ALTER TABLE issues ADD COLUMN agent_status TEXT");
tryExec("ALTER TABLE issues ADD COLUMN agent_status_at TEXT");
tryExec("ALTER TABLE issues ADD COLUMN agent_status_session_id TEXT REFERENCES agent_sessions(id)");

export function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
