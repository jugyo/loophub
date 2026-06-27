import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { dbPath } from "./config.ts";

// node:sqlite is an experimental builtin (Node 22.x, behind --experimental-sqlite).
// Load it through createRequire so bundler-based transformers (Vite/vitest) don't try
// to statically resolve the `node:sqlite` specifier as a package.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;
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

// LoopHub shares a single LOOPHUB_DB across processes (the `lh` CLI and the resident
// `lh-web`). With WAL, writers still serialize, so a write issued while another process
// holds the write lock would otherwise get an immediate `SQLITE_BUSY` ("database is
// locked"). `PRAGMA busy_timeout` makes SQLite wait (synchronously, inside the native
// call) up to this many ms for the lock before giving up — the primary fix.
const BUSY_TIMEOUT_MS = 5000;

// busy_timeout covers the common contention case. In rare situations SQLite can still
// return SQLITE_BUSY after the timeout elapses (e.g. a checkpoint/deadlock-prone moment),
// so we add a small bounded retry on writes as a backstop. Reads are left to busy_timeout.
const WRITE_RETRY_ATTEMPTS = 4;
const SQLITE_BUSY = 5;

function isBusyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errcode?: number; message?: string };
  return (
    e.errcode === SQLITE_BUSY ||
    /database is locked|SQLITE_BUSY/i.test(e.message ?? "")
  );
}

// Synchronous sleep (the node:sqlite surface is fully synchronous, so we cannot await).
// Atomics.wait blocks the thread without busy-spinning the CPU.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Retry a synchronous write on residual SQLITE_BUSY with a short exponential backoff.
function withWriteRetry<T>(op: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (!isBusyError(err) || attempt >= WRITE_RETRY_ATTEMPTS - 1) throw err;
      sleepSync(25 * 2 ** attempt); // 25, 50, 100 ms
    }
  }
}

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
    withWriteRetry(() => this.#raw.exec(sql));
  }

  query(sql: string): BunStyleQuery {
    const stmt = this.#prepare(sql);
    return {
      get: (...params: Param[]) =>
        stmt.get(...(normalize(params) as never[])) ?? null,
      all: (...params: Param[]) => stmt.all(...(normalize(params) as never[])),
      run: (...params: Param[]) => {
        withWriteRetry(() => stmt.run(...(normalize(params) as never[])));
      },
    };
  }

  run(sql: string, params: Param[] = []): void {
    withWriteRetry(() =>
      this.#prepare(sql).run(...(normalize(params) as never[])),
    );
  }
}

const path = dbPath();
mkdirSync(dirname(path), { recursive: true });

export const db = new Db(path);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
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
  head_sha    TEXT,
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
  runtime           TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (agent, external_session)
);

-- Standalone image blobs embedded in markdown bodies. Metadata only; the blob
-- itself is content-addressed on disk under $LOOPHUB_HOME/attachments/. The
-- sha256 is both the primary key and the URL identifier; nothing references a
-- repo/issue/PR (any body may embed any blob), and blobs are never GC'd.
CREATE TABLE IF NOT EXISTS attachments (
  sha256      TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Loop retrospectives (loop-retrospective-design.ja.md §4.2). One row per
-- generated retro: rubric scores + free-form findings for a (merged) PR, stored
-- structured for later aggregation/UI. session_id is the *implementation* session
-- (resolved from the PR row's own session attribution, pulls.session_id), NULL
-- when the PR has none. findings_json / rubric note are sensitive at-rest; redacted/redact_ruleset
-- record the redaction version so weakly-redacted rows can be re-processed later.
CREATE TABLE IF NOT EXISTS retros (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id        INTEGER REFERENCES repos(id),
  issue_id       INTEGER REFERENCES issues(id),
  pr_id          INTEGER REFERENCES issues(id),
  session_id     TEXT    REFERENCES agent_sessions(id),
  rubric_json    TEXT NOT NULL DEFAULT '[]',
  findings_json  TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'draft',
  reviewed_by    TEXT,
  redacted       INTEGER NOT NULL DEFAULT 0,
  redact_ruleset TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retros_repo ON retros(repo_id, id);
CREATE INDEX IF NOT EXISTS idx_retros_pr   ON retros(pr_id);

-- Review notes (#204). A short human-written description attached to a single file
-- inside a PR's review, to help a reviewer (what the file is, what changed, what to
-- look at). The note is bound to a *diff range*: base_sha -> commit_sha. Storing both
-- shas on the row makes "the note is about the base->target diff" explicit in the model
-- rather than implied by the PR's current refs. issue_id is the PR (an issues row with
-- kind='pull'); a note therefore always belongs to a PR and to a concrete commit range.
-- Notes are never auto-migrated when the head advances: a note whose commit_sha no longer
-- matches the PR head is simply "stale" (still retrievable; staleness is a consumer call).
-- Multiple notes per file are allowed (no UNIQUE on path) — like review_comments.
CREATE TABLE IF NOT EXISTS review_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id),
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  base_sha    TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  path        TEXT NOT NULL,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_notes_pr        ON review_notes(issue_id);
CREATE INDEX IF NOT EXISTS idx_review_notes_pr_commit ON review_notes(issue_id, commit_sha);
`);

// 既存 DB 向けの軽量マイグレーション（カラムが既にあれば throw → 無視）
function tryExec(sql: string) {
  try {
    db.exec(sql);
  } catch {}
}

tryExec("ALTER TABLE pulls ADD COLUMN head_sha TEXT");
tryExec("ALTER TABLE review_comments ADD COLUMN review_id INTEGER");
tryExec(
  "ALTER TABLE pulls ADD COLUMN linked_issue_id INTEGER REFERENCES issues(id)",
);
tryExec(
  "CREATE INDEX IF NOT EXISTS idx_pulls_linked_issue ON pulls(linked_issue_id)",
);
tryExec("ALTER TABLE repos ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
tryExec("ALTER TABLE repos ADD COLUMN archived_at TEXT");
// issue assignee (`@lh-dev`) is retired (#186): the load-bearing roles it held — the double
// `lh dev` guard and `lh resume`/retro session resolution — moved to PR rows. Session resolution
// now reads pulls.session_id; the double-`lh dev` guard is a soft check (`lh dev` reuses the open
// linked PR, `resolveLinkedIssueId` refuses a second one) backed by the host-local dev lock — not a
// DB constraint, so a single issue may carry multiple proposal PRs in the future (see #186 dev.note).
// The migration order matters: add pulls.session_id and backfill it from the retiring assignee
// BEFORE dropping the column, so PRs open (or pending retro) at upgrade time keep their attribution.
//
// pulls.session_id: the dev session that opened/worked this PR. Replaces the issue-assignee path
// for `lh resume`/retro session resolution (#186); set by `lh dev` when it opens or re-enters a PR.
tryExec(
  "ALTER TABLE pulls ADD COLUMN session_id TEXT REFERENCES agent_sessions(id)",
);
// Backfill from the old assignee so existing PRs stay resolvable after the column is dropped. The
// old resolution preferred the PR's own assignee (direct `lh dev <pr>`) over the linked issue's
// (the common `lh dev <issue>` flow), so seed the own-row value first, then the linked-issue value
// for rows still NULL. On a fresh DB the assignee column never existed, so these throw and are
// ignored (and there is no data to backfill anyway).
tryExec(
  `UPDATE pulls SET session_id = (SELECT assignee_session_id FROM issues WHERE issues.id = pulls.issue_id)
   WHERE session_id IS NULL
     AND (SELECT assignee_session_id FROM issues WHERE issues.id = pulls.issue_id) IS NOT NULL`,
);
tryExec(
  `UPDATE pulls SET session_id = (SELECT assignee_session_id FROM issues WHERE issues.id = pulls.linked_issue_id)
   WHERE session_id IS NULL AND linked_issue_id IS NOT NULL
     AND (SELECT assignee_session_id FROM issues WHERE issues.id = pulls.linked_issue_id) IS NOT NULL`,
);
// Now that pulls.session_id is backfilled, drop the retired assignee column and its unique index
// (the index first, so DROP COLUMN is permitted).
tryExec("DROP INDEX IF EXISTS idx_issues_assignee_session");
tryExec("ALTER TABLE issues DROP COLUMN assignee_session_id");
// Converge DBs that ran the intermediate #186 migration (which added a maintained
// pulls.open_linked_issue_id column + partial unique index as a hard "one open PR per issue"
// constraint). That approach was dropped in favor of the soft guard so an issue can carry multiple
// proposal PRs later; remove the now-unmaintained column and index. On a fresh DB they never
// existed, so DROP INDEX no-ops and DROP COLUMN throws and is ignored.
tryExec("DROP INDEX IF EXISTS idx_pulls_open_linked_issue");
tryExec("ALTER TABLE pulls DROP COLUMN open_linked_issue_id");
tryExec("ALTER TABLE pulls ADD COLUMN changes_addressed_at TEXT");
tryExec("ALTER TABLE pulls ADD COLUMN changes_addressed_by TEXT");
// reviews.head_sha records the PR head a review was made against, so an APPROVE
// can be marked stale once the branch advances past that commit.
tryExec("ALTER TABLE reviews ADD COLUMN head_sha TEXT");
// agent_sessions.runtime records which runtime launched the session (e.g. "claude-code"), so
// `lh resume` picks the resume command by runtime instead of inferring it from the agent label.
// Pre-existing rows get NULL and rely on the lh-dev → claude-code backward-compat fallback
// (core/resume.ts sessionRuntime).
tryExec("ALTER TABLE agent_sessions ADD COLUMN runtime TEXT");

export function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
