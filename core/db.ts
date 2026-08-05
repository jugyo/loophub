import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { dbPath } from "./config.ts";
import { runMigrations } from "./migrations.ts";
import { measureSlowOperation } from "./slow-operation.ts";

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

// SQLite auto-checkpoints WAL at 1,000 pages (about 4 MiB with the default
// page size). Keep one additional checkpoint window for reuse while preventing
// old write bursts from leaving an indefinitely large WAL on disk.
const JOURNAL_SIZE_LIMIT_BYTES = 8 * 1024 * 1024;

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

/**
 * A `() => unknown` callback that provably finishes before it returns.
 *
 * `Extract` distributes over the callback's inferred return type, so a union with a single
 * `PromiseLike` member (`Promise<void> | undefined`) still collapses the parameter to `never` and
 * fails to compile. Keeping the callback generic rather than declaring it `() => void` is what
 * preserves that inference: contextual typing to `void` would erase the `Promise` we look for.
 */
export type SyncCallback<F extends () => unknown> = F &
  ([Extract<ReturnType<F>, PromiseLike<unknown>>] extends [never]
    ? unknown
    : never);

const AsyncFunction = (async () => {}).constructor;

function isThenable(value: unknown): boolean {
  if (typeof value !== "object" && typeof value !== "function") return false;
  return typeof (value as PromiseLike<unknown> | null)?.then === "function";
}

export class Db {
  #raw: DatabaseSync;
  #cache = new Map<string, StatementSync>();
  // Depth of the transaction this connection owns; 0 means no transaction is open.
  #depth = 0;
  // Callbacks handed to `afterCommit` while a transaction was open. They run when the outermost
  // COMMIT succeeds; if it rolls back instead, they are discarded without ever being called.
  #afterCommit: (() => void)[] = [];

  constructor(path: string) {
    this.#raw = new DatabaseSync(path);
  }

  /** Whether this connection is currently inside a synchronous command transaction. */
  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  /**
   * Run `callback` once the write it announces is durable.
   *
   * With a transaction open the callback waits for the outermost `COMMIT`, so whoever it wakes
   * cannot read the database before the write it was told about is there; if that transaction
   * rolls back instead, the callback is discarded without running, because the write it would
   * announce never happened. With no transaction open the single statement is already committed,
   * so the callback runs on the spot — waiting for a `COMMIT` that is never coming would silence
   * it forever.
   *
   * A callback owns its own failures: it runs after the command it belongs to has succeeded, so
   * throwing from here would report that committed command as failed.
   */
  afterCommit(callback: () => void): void {
    if (this.#depth === 0) {
      callback();
      return;
    }
    this.#afterCommit.push(callback);
  }

  #runAfterCommit(): void {
    const callbacks = this.#afterCommit;
    this.#afterCommit = [];
    for (const callback of callbacks) callback();
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
    measureSlowOperation(
      "sql",
      () => `sql=${JSON.stringify(sql)}`,
      () => withWriteRetry(() => this.#raw.exec(sql)),
    );
  }

  query(sql: string): BunStyleQuery {
    const stmt = this.#prepare(sql);
    return {
      get: (...params: Param[]) =>
        measureSlowOperation(
          "sql",
          () => `sql=${JSON.stringify(sql)}`,
          () => stmt.get(...(normalize(params) as never[])) ?? null,
        ),
      all: (...params: Param[]) =>
        measureSlowOperation(
          "sql",
          () => `sql=${JSON.stringify(sql)}`,
          () => stmt.all(...(normalize(params) as never[])),
        ),
      run: (...params: Param[]) => {
        measureSlowOperation(
          "sql",
          () => `sql=${JSON.stringify(sql)}`,
          () =>
            withWriteRetry(() => stmt.run(...(normalize(params) as never[]))),
        );
      },
    };
  }

  run(sql: string, params: Param[] = []): void {
    measureSlowOperation(
      "sql",
      () => `sql=${JSON.stringify(sql)}`,
      () =>
        withWriteRetry(() =>
          this.#prepare(sql).run(...(normalize(params) as never[])),
        ),
    );
  }

  /**
   * Run `callback` inside a transaction and return its value.
   *
   * The outermost call owns `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`; a nested call joins the
   * transaction already open and never commits it. A store helper therefore stays atomic when
   * called on its own, while a caller that wraps several helpers gets one transaction covering all
   * of them. An error propagates to the outermost caller, which rolls the whole transaction back —
   * catching it inside the callback to keep going would commit half a command.
   *
   * The callback must be synchronous: SQLite here is synchronous, so work resumed after an `await`
   * would land outside the transaction it appears to belong to. The compile-time guard is
   * `SyncCallback`; the checks below cover callers that get past it (a type assertion, or plain
   * JavaScript).
   */
  transaction<F extends () => unknown>(
    callback: SyncCallback<F>,
  ): ReturnType<F> {
    const fn = callback as () => unknown;
    if (fn instanceof AsyncFunction) {
      throw new TypeError(
        "db.transaction requires a synchronous callback (received an async function)",
      );
    }
    if (this.#depth > 0) {
      this.#depth++;
      try {
        return this.#callSync(fn) as ReturnType<F>;
      } finally {
        this.#depth--;
      }
    }
    this.run("BEGIN IMMEDIATE");
    this.#depth = 1;
    let result: unknown;
    try {
      result = this.#callSync(fn);
    } catch (error) {
      this.#depth = 0;
      this.#afterCommit = [];
      try {
        this.run("ROLLBACK");
      } catch {
        // SQLite already aborted the transaction in the cases where ROLLBACK itself errors; a
        // failed rollback must not mask the failure we are about to report.
      }
      throw error;
    }
    this.#depth = 0;
    this.run("COMMIT");
    this.#runAfterCommit();
    return result as ReturnType<F>;
  }

  // A callback that returns a thenable has not finished, so committing would persist a partial
  // command. Throwing makes it a visible programming error and rolls the transaction back; side
  // effects the returned promise already started cannot be undone from here.
  #callSync(callback: () => unknown): unknown {
    const result = callback();
    if (isThenable(result)) {
      throw new TypeError(
        "db.transaction callback returned a thenable; transaction callbacks must be synchronous",
      );
    }
    return result;
  }
}

// The current shape of every table this application creates. Historical databases converge on it
// through core/migrations.ts, so a column added here needs a matching migration there (and vice
// versa — core/migrations.test.ts compares a fresh database against a migrated one).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  owner         TEXT NOT NULL,
  local_path    TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  branch      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (repo_id, branch)
);

CREATE TABLE IF NOT EXISTS issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id),
  number      INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open',
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  target_branch TEXT,
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (repo_id, number)
);

-- Structured acceptance criteria (#1894). id is the repository-wide stable identity used by
-- grade FKs; number is the stable, 1-based human reference within an issue; and ordinal is only
-- the mutable display position. Criteria are never deleted — an unwanted one is disabled
-- (enabled = 0), leaving the row and its future grades intact. The markdown "## Acceptance
-- criteria" section is not parsed; this table is the only source.
CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  number      INTEGER NOT NULL DEFAULT 0,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- Monotonic repository-wide allocator shared by Issues and PRs. Keeping the high-water mark
-- outside issues means hard-deleting the highest-numbered row cannot make that number reusable.
CREATE TABLE IF NOT EXISTS repo_number_sequences (
  repo_id      INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  last_number  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pulls (
  issue_id        INTEGER PRIMARY KEY REFERENCES issues(id),
  head_ref        TEXT NOT NULL,
  base_ref        TEXT NOT NULL,
  base_sha        TEXT,
  head_sha        TEXT,
  head_pending_creation INTEGER NOT NULL DEFAULT 0,
  merged          INTEGER NOT NULL DEFAULT 0,
  merged_at       TEXT,
  merge_commit_sha TEXT,
  merge_method    TEXT,
  archived_at     TEXT
);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  author      TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  author      TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'system' CHECK (author_type IN ('human', 'agent', 'system')),
  event       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  head_sha    TEXT,
  model       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  review_id   INTEGER REFERENCES reviews(id),
  author      TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
  body        TEXT NOT NULL,
  path        TEXT NOT NULL,
  line        INTEGER,
  side        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_responses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id          INTEGER NOT NULL REFERENCES issues(id),
  review_id         INTEGER NOT NULL REFERENCES reviews(id),
  review_comment_id INTEGER REFERENCES review_comments(id),
  author            TEXT NOT NULL,
  body              TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_review_responses_issue_review
  ON review_responses(issue_id, review_id, created_at, id);

CREATE TABLE IF NOT EXISTS diff_feedback_threads (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id       INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  pr_number      INTEGER NOT NULL,
  base_sha       TEXT NOT NULL,
  head_sha       TEXT NOT NULL,
  path           TEXT NOT NULL,
  original_path  TEXT,
  side           TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
  start_line     INTEGER NOT NULL CHECK (start_line > 0),
  end_line       INTEGER NOT NULL CHECK (end_line >= start_line),
  created_by     TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('human', 'agent', 'system')),
  created_at     TEXT NOT NULL,
  archived_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_diff_feedback_threads_issue
  ON diff_feedback_threads(issue_id);

CREATE TABLE IF NOT EXISTS diff_feedback_locations (
  thread_id              INTEGER NOT NULL REFERENCES diff_feedback_threads(id) ON DELETE CASCADE,
  base_sha               TEXT NOT NULL,
  head_sha               TEXT NOT NULL,
  resolved_anchor_json   TEXT,
  freshness              TEXT NOT NULL,
  outdated_reason        TEXT,
  placement              TEXT NOT NULL,
  original_context_json  TEXT,
  PRIMARY KEY (thread_id, base_sha, head_sha)
);

CREATE TABLE IF NOT EXISTS diff_feedback_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL REFERENCES diff_feedback_threads(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_diff_feedback_messages_thread
  ON diff_feedback_messages(thread_id, created_at, id);

CREATE TABLE IF NOT EXISTS diff_feedback_reactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES diff_feedback_messages(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (message_id, author)
);

CREATE INDEX IF NOT EXISTS idx_diff_feedback_reactions_message
  ON diff_feedback_reactions(message_id, created_at, id);

-- Per-criterion grade of an acceptance criterion by a review (#1895). A child fact of the review
-- row, mirroring review_comments: it inherits the review's head_sha pin and staleness with no extra
-- machinery (a grade goes stale when its review does). criterion_id targets the stable id, so the
-- correspondence survives AC edits and reordering; criteria are never deleted (disabled instead), so
-- this FK can never dangle.
CREATE TABLE IF NOT EXISTS review_ac_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id    INTEGER NOT NULL REFERENCES reviews(id),
  criterion_id INTEGER NOT NULL REFERENCES acceptance_criteria(id),
  verdict      TEXT NOT NULL,              -- 'pass' | 'fail'
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
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
-- notificationSourceCursors sweep (listNotificationSignalRows in store/notifications.ts) scans
-- a bounded id range for one event type at a time with no repo_id filter, so a plain
-- (repo_id, id) index can't help it; (type, id) lets it seek straight to the range.
CREATE INDEX IF NOT EXISTS idx_events_type_id ON events(type, id);
-- Per-PR lookups (firstReadyForReviewAt, hasCostStopEvent, hasAnyCostStopEvent in
-- store/events.ts, and the "already ready" NOT EXISTS check in store/session-usage.ts) all
-- filter on repo_id + a single literal type + the PR number embedded in payload, sometimes
-- narrowed further by session_id. events is written on essentially every git/PR/session/issue
-- action across ~30 event types, but only these two types (pull_request.ready_for_review,
-- dev.cost_stopped) are ever looked up this way, so each index below is a partial index scoped
-- to its one type with a WHERE type = '<literal>' clause -- this keeps the json_extract
-- evaluation and btree upkeep off every insert for the other ~28 event types. SQLite's partial
-- index matching is purely syntactic (it does not prove that type = 'x' implies
-- type IN ('x', 'y')), so this must stay two single-type indexes rather than one indexed on
-- type IN (...) -- and the query text must keep using a literal type (not a bound ? parameter)
-- for SQLite to recognize the partial condition is satisfied. SQLite also matches expression
-- indexes by their parsed form, not raw text, so both indexes are interchangeable with the bare
-- payload column and the aliased e.payload call sites (verified via EXPLAIN QUERY PLAN). The
-- match set per repo_id+number is always tiny in practice (a PR flips to ready, or gets
-- cost-stopped, at most a handful of times).
CREATE INDEX IF NOT EXISTS idx_events_repo_ready_number_id
  ON events(repo_id, json_extract(payload, '$.number'), id)
  WHERE type = 'pull_request.ready_for_review';
CREATE INDEX IF NOT EXISTS idx_events_repo_cost_stopped_number_session_id
  ON events(repo_id, json_extract(payload, '$.number'), json_extract(payload, '$.session_id'), id)
  WHERE type = 'dev.cost_stopped';
-- Workflow lifecycle lookups by run id (workflowRunsWithPendingEvents in store/workflows.ts,
-- eventsForWorkflowRun in store/events.ts). The first of those runs once per second in the worker's
-- event tail and, without this index, re-scanned every event after each run's cursor -- a cost that
-- grows with both the events table and the number of recorded runs, and that blocks the whole worker
-- event loop because node:sqlite is synchronous. Unlike the two indexes above this one covers a
-- whole type family rather than a single literal type, so its partial condition repeats the
-- callers' GLOB pair verbatim (SQLite matches partial indexes syntactically, so the query text has
-- to keep both GLOBs in that exact form). The CAST is load-bearing too: run ids are compared
-- against workflow_runs.id, an INTEGER-affinity column, and SQLite only uses an expression index
-- when the comparison's affinity matches the indexed expression's -- a bare json_extract has none,
-- so the correlated lookup silently fell back to a scan.
CREATE INDEX IF NOT EXISTS idx_events_repo_workflow_run_id
  ON events(repo_id, CAST(json_extract(payload, '$.id') AS INTEGER), id)
  WHERE type GLOB 'workflow_run.*' OR type GLOB 'workflow_step.*';

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                TEXT PRIMARY KEY,
  agent             TEXT NOT NULL,
  external_session  TEXT NOT NULL,
  name              TEXT,
  runtime           TEXT,
  kind              TEXT,
  model             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (agent, external_session)
);

-- Runtime-specific address for controlling a live agent. Workflow code resolves targets through
-- the owning session and delegates operations to an agent-control adapter.
CREATE TABLE IF NOT EXISTS agent_execution_targets (
  session_id  TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  context     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Generalized session<->target links (#298). A session can relate to any issues row — an
-- issue (kind=issue) OR a PR (kind=pull) — and a single issue/PR can carry many sessions
-- (dev, review, issue-create, ...), so this is a plain many-to-many bridge keyed by the pair.
-- This replaces the old 1:1 pulls.session_id attribution (dropped in #316): the PR's primary dev
-- session — the usage attribution/retro anchor — is now derived as the latest kind='dev' link
-- here (store.primaryDevSessionForPull). The session's own kind lives on agent_sessions.kind;
-- created_at is when the link was made (the basis for ordering the related-sessions list newest-first).
CREATE TABLE IF NOT EXISTS session_links (
  session_id  TEXT NOT NULL REFERENCES agent_sessions(id),
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, issue_id)
);

CREATE INDEX IF NOT EXISTS idx_session_links_issue ON session_links(issue_id);

CREATE TABLE IF NOT EXISTS session_usage (
  session_id                  TEXT NOT NULL REFERENCES agent_sessions(id),
  model                       TEXT NOT NULL,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cost_usd                    REAL,
  context_usage_percent       REAL,
  updated_at                  TEXT NOT NULL,
  PRIMARY KEY (session_id, model)
);

-- Short-lived observation samples for token-rate display. session_usage stores only cumulative
-- per-session/model totals, so it cannot reconstruct historical tokens/sec after the fact; rates
-- are estimated from samples recorded at usage-sync time. token_delta excludes cache reads;
-- cache_read_delta records that throughput separately.
CREATE TABLE IF NOT EXISTS session_usage_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES agent_sessions(id),
  total_tokens INTEGER NOT NULL,
  token_delta  INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_delta  INTEGER NOT NULL DEFAULT 0,
  observed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_usage_samples_session_time
  ON session_usage_samples(session_id, observed_at);

-- Persisted history of the live aggregate tokens/sec shown in the topbar (#1123). Unlike
-- session_usage_samples (pruned at ~600s), these rows survive so the historical rate time series can be
-- reconstructed after the source samples are gone. One row per sweep holds the same aggregate rate the
-- topbar displays (calculateTokensPerSecond over in-progress dev sessions); retention is bounded by a
-- longer prune window instead of the sample TTL.
CREATE TABLE IF NOT EXISTS session_rate_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tokens_per_second REAL NOT NULL,
  observed_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_rate_history_time
  ON session_rate_history(observed_at);

CREATE TABLE IF NOT EXISTS session_usage_subagents (
  session_id                  TEXT NOT NULL REFERENCES agent_sessions(id),
  source_id                   TEXT NOT NULL,
  parent_source_id            TEXT,
  label                       TEXT,
  kind                        TEXT NOT NULL,
  model                       TEXT NOT NULL,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cost_usd                    REAL,
  context_usage_percent       REAL,
  updated_at                  TEXT NOT NULL,
  PRIMARY KEY (session_id, source_id, model)
);

CREATE INDEX IF NOT EXISTS idx_session_usage_subagents_session
  ON session_usage_subagents(session_id);

CREATE TABLE IF NOT EXISTS session_usage_cursors (
  session_id      TEXT PRIMARY KEY REFERENCES agent_sessions(id),
  transcript_path TEXT NOT NULL,
  cursor_offset   INTEGER NOT NULL DEFAULT 0,
  mtime_ms        REAL NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_usage_messages (
  session_id  TEXT NOT NULL REFERENCES agent_sessions(id),
  message_id  TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
);

-- Standalone attachment blobs referenced from markdown bodies. Metadata only; the blob
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
-- (resolved from the PR's session_links via store.primaryDevSessionForPull since #316), NULL
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

-- Handoffs (#352). The orchestrator<->subagent handoff bus, made durable: each row is one
-- explicit document passed between a parent orchestrator and a child subagent — the parent's
-- instruction (direction='down') or the child's return (direction='up') — recorded out of the
-- volatile conversation so a run's trajectory can be replayed, audited, and evaluated later —
-- the harness's "observability" layer. Generic on purpose: any orchestration records through the
-- same protocol; no orchestration-specific column is required.
--
-- Linkage (the "ref"): a handoff binds to a PR (pr_id, the kind='pull' issues row) and/or its
-- session (session_id), the two anchors handoffs accumulate on; issue_id is the optional
-- generic linkage (a future issue-stage orchestration) so the mechanism is not PR-only. At least
-- one of pr_id/issue_id is required (enforced in service.ts, not as a DB constraint, so the schema
-- stays generic). seq is a per-ref monotonic counter (1,2,3…) giving handoffs a stable order
-- independent of created_at's second precision.
--
-- Body is HYBRID (the key design decision): content with no other home — the parent's instruction
-- prompt, the Verify report — lives INLINE in 'body'. Content whose canonical copy is elsewhere —
-- plan=PR, diff=git commit — is NOT duplicated: 'src' references the canonical (e.g. a commit sha
-- or comment id) and 'hash' is its content hash (sha256), so the reference is verifiable without a
-- second copy. Exactly one of (body, src) is the substance; the other is null.
--
-- Security: rows are stored UNENCRYPTED and never GC'd (durable by design), so
-- secrets (credentials/tokens) must never be written here; the redaction rule lives with the
-- caller (service validates shape, not secrecy). model/cost are optional observability fields for
-- model-routing/economics analysis; cost is free-form JSON text (tokens/latency) the
-- consumer parses. from_role/to_role label the agents (parent / 'code' sub / …).
CREATE TABLE IF NOT EXISTS handoffs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id),
  pr_id       INTEGER REFERENCES issues(id),
  issue_id    INTEGER REFERENCES issues(id),
  session_id  TEXT    REFERENCES agent_sessions(id),
  seq         INTEGER NOT NULL,
  phase       TEXT NOT NULL,
  direction   TEXT NOT NULL,
  from_role   TEXT,
  to_role     TEXT,
  body        TEXT,
  src         TEXT,
  hash        TEXT,
  summary     TEXT,
  model       TEXT,
  cost        TEXT,
  created_at  TEXT NOT NULL
);

-- seq is minted per primary ref (pr if present, else issue, else session — see nextHandoffSeq).
-- These UNIQUE partial indexes back that invariant the way issues' UNIQUE (repo_id, number) backs
-- nextNumber: seq is MAX(seq)+1 read in one statement then INSERTed in another, so two processes
-- (parallel 'lh handoff record' from concurrent subagents) can read the same MAX; the unique index
-- makes the second INSERT throw instead of silently duplicating seq, and createHandoff retries with
-- a recomputed seq. The partial predicates mirror the seq scope exactly so they never false-collide:
-- the pr index covers every pr-bound row (seq minted in pr scope whenever pr_id is set); the issue
-- index covers only issue-bound rows with no pr (seq minted in issue scope only when pr_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_pr_seq    ON handoffs(pr_id, seq) WHERE pr_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_issue_seq ON handoffs(issue_id, seq) WHERE pr_id IS NULL AND issue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_handoffs_issue   ON handoffs(issue_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_session ON handoffs(session_id);

-- The GitHub PR a loophub PR was exported to (#406). A loophub PR can have at most one GitHub PR,
-- so this is a 1:1 side table keyed by the PR's issues row id (pulls.issue_id). Kept out of the
-- pulls table because it is a distinct concept (an external artifact, populated asynchronously by
-- the export skill) and most PRs never have one. The branch column records the GitHub-side branch
-- the skill pushed (deliberately unrelated to the internal loophub branch); created_by is the actor
-- that recorded it. Presence of a row is what flips the PR-detail button from Create to View PR.
CREATE TABLE IF NOT EXISTS github_pulls (
  issue_id    INTEGER PRIMARY KEY REFERENCES issues(id),
  number      INTEGER NOT NULL,
  url         TEXT NOT NULL,
  branch      TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

-- The GitHub issue a loophub issue was imported from (#614). Deliberately MANY-to-ONE, not 1:1 like
-- github_pulls: a single GitHub issue may be imported into several loophub issues (re-imported, split
-- across repos), so the key is the loophub issue (issue_id, PRIMARY KEY) — each import produces one
-- fresh loophub issue linked to exactly one GitHub source — while the source coordinates
-- (owner/repo/number) repeat across rows. The idx_github_issues_source index resolves "which loophub
-- issues came from this GitHub issue". owner/repo/number are the GitHub identity (parsed from the URL);
-- url is stored verbatim for display. No reverse sync — the copy is one-shot at import time.
CREATE TABLE IF NOT EXISTS github_issues (
  issue_id    INTEGER PRIMARY KEY REFERENCES issues(id),
  owner       TEXT NOT NULL,
  repo        TEXT NOT NULL,
  number      INTEGER NOT NULL,
  url         TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_issues_source ON github_issues(owner, repo, number);

-- A cache of a GitHub PR's live status (draft / review / checks / comment counts / merged), fetched
-- on demand via gh for the PR-detail right sidebar (#850). 1:1 with a github_pulls row (keyed by the
-- PR's issues row id). payload is the JSON of the normalized status (core/github.ts GhPrStatus) and
-- synced_at is when it was fetched — the service serves this within a short TTL before hitting gh
-- again, so it is a cache, not authoritative state (github_pulls.github_merged remains the
-- authoritative merge signal used by the worker and Notification Center).
CREATE TABLE IF NOT EXISTS github_pull_status (
  issue_id   INTEGER PRIMARY KEY REFERENCES issues(id),
  payload    TEXT NOT NULL,
  synced_at  TEXT NOT NULL
);

-- Last content observed for each GitHub PR feedback item. Only the digest is retained: GitHub
-- bodies are untrusted input and never need to enter LoopHub events or agent notification prompts.
-- The content digest (rather than updated_at alone) also catches edits when GitHub's timestamp is
-- absent or unexpectedly unchanged.
CREATE TABLE IF NOT EXISTS github_pull_feedback (
  issue_id     INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('issue_comment', 'review', 'review_comment')),
  github_id    INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  PRIMARY KEY (issue_id, kind, github_id)
);

-- LoopHub-created Herdr panes are first-class, repo-owned records. launch_id is the durable
-- correlation key shared by the launcher and the resource-producing flow; pane_id/session_name are
-- the coordinates Herdr needs for focus, while display_name/origin describe the pane without tying
-- this table to any one LoopHub resource type. All four descriptive fields are nullable because a
-- resource link may arrive before the launcher finishes registering the pane.
CREATE TABLE IF NOT EXISTS herdr_panes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      INTEGER NOT NULL REFERENCES repos(id),
  launch_id    TEXT NOT NULL,
  pane_id      TEXT,
  session_name TEXT,
  display_name TEXT,
  origin       TEXT,
  lifecycle_managed INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_managed IN (0, 1)),
  closed_at    TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (repo_id, launch_id)
);

CREATE INDEX IF NOT EXISTS idx_herdr_panes_coordinates
  ON herdr_panes(session_name, pane_id)
  WHERE session_name IS NOT NULL AND pane_id IS NOT NULL;

-- Polymorphic resource links keep resource-specific nullable columns out of herdr_panes.
-- resource_kind is intentionally open text (for example issue, pull, workflow_run), and
-- resource_key is text so future resources are not restricted to SQLite integer identifiers.
CREATE TABLE IF NOT EXISTS herdr_pane_resources (
  pane_id       INTEGER NOT NULL REFERENCES herdr_panes(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL,
  resource_key  TEXT NOT NULL,
  relationship  TEXT NOT NULL DEFAULT 'related',
  created_at    TEXT NOT NULL,
  PRIMARY KEY (pane_id, resource_kind, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_herdr_pane_resources_resource
  ON herdr_pane_resources(resource_kind, resource_key, pane_id);

-- Resource links describe navigation and history. Claims separately describe why a pane must stay
-- alive. Releasing a claim never deletes either row, so lifecycle decisions retain their audit
-- trail and resource links remain available after the managed pane closes.
CREATE TABLE IF NOT EXISTS herdr_pane_claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pane_id       INTEGER NOT NULL REFERENCES herdr_panes(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL,
  resource_key  TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  released_at   TEXT,
  UNIQUE (pane_id, resource_kind, resource_key, purpose)
);

CREATE INDEX IF NOT EXISTS idx_herdr_pane_claims_resource
  ON herdr_pane_claims(resource_kind, resource_key, pane_id);

CREATE INDEX IF NOT EXISTS idx_herdr_pane_claims_active
  ON herdr_pane_claims(pane_id)
  WHERE released_at IS NULL;

-- A subscriber declares "wake this target when these resources change". Whoever delivers a wake-up
-- reads only these two tables: it never derives a subscriber from a domain row (a workflow run's
-- pr_number, say), so the delivery path carries no caller's domain knowledge and no caller's
-- lifetime rules. Subscriptions are created and released by the subscriber itself.
--
-- target is the transport, currently only a Herdr pane; pane_id points at the herdr_panes row that
-- already holds the pane coordinates, so they are not duplicated here.
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id    INTEGER NOT NULL REFERENCES repos(id),
  target     TEXT NOT NULL CHECK (target IN ('herdr-pane')),
  pane_id    INTEGER NOT NULL REFERENCES herdr_panes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

-- Same shape as herdr_pane_resources: resource_kind is intentionally open text (for example issue,
-- pull, workflow_run) and resource_key is text so future resources are not restricted to SQLite
-- integer identifiers.
CREATE TABLE IF NOT EXISTS event_subscription_resources (
  subscription_id INTEGER NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  resource_kind   TEXT NOT NULL,
  resource_key    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (subscription_id, resource_kind, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_event_subscription_resources_resource
  ON event_subscription_resources(resource_kind, resource_key, subscription_id);

-- Retired scheduled-task storage. Keep these tables so existing installations retain their saved
-- rows and historical run metadata; there is intentionally no active service or worker producer.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id),
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  agent       TEXT NOT NULL,
  times_json  TEXT NOT NULL DEFAULT '[]',
  model       TEXT,
  effort      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_repo ON scheduled_tasks(repo_id, id);

-- Historical run metadata for the retired scheduled-task feature. Retained for non-destructive
-- compatibility with databases created while the feature was active.
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL REFERENCES scheduled_tasks(id),
  repo_id        INTEGER NOT NULL REFERENCES repos(id),
  trigger        TEXT NOT NULL,
  scheduled_time TEXT,
  fire_key       TEXT,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  status         TEXT NOT NULL DEFAULT 'running',
  herdr_tab_id   TEXT,
  herdr_pane_id  TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task ON scheduled_task_runs(task_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_task_runs_fire_key
  ON scheduled_task_runs(task_id, fire_key) WHERE fire_key IS NOT NULL;

-- Notification center (#1062). Notifications are topbar alerts about LoopHub state transitions,
-- with a typed resource target and optional Herdr pane action.
CREATE TABLE IF NOT EXISTS notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id        INTEGER NOT NULL REFERENCES repos(id),
  kind           TEXT NOT NULL
                   CHECK (kind IN ('merge_ready', 'over_budget', 'human_attention')),
  severity       TEXT NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('info', 'warning')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  resource_kind  TEXT NOT NULL CHECK (resource_kind IN ('issue', 'pull', 'repo')),
  resource_number INTEGER,
  source_key     TEXT NOT NULL UNIQUE,
  herdr_pane_id  TEXT,
  -- The Workflow run this notification is about, when it came from a run-scoped signal. It names
  -- the run a reader can act on (a cost-held run's limit increase) without parsing title or body.
  workflow_run_id INTEGER,
  read_at        TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_read_created
  ON notifications(read_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_notifications_repo
  ON notifications(repo_id, id);

-- Last observed mergeable state per open PR. transition_count advances only when a PR enters
-- clean; it becomes the durable notification source key, so repeated sweeps are idempotent while
-- a later non-clean -> clean transition can notify again.
CREATE TABLE IF NOT EXISTS notification_merge_ready_states (
  repo_id           INTEGER NOT NULL REFERENCES repos(id),
  pull_number       INTEGER NOT NULL,
  state             TEXT NOT NULL
                      CHECK (state IN ('clean', 'conflict', 'no_commits', 'blocked', 'unknown')),
  transition_count  INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (repo_id, pull_number)
);

CREATE TABLE IF NOT EXISTS notification_cursors (
  scope     TEXT PRIMARY KEY,
  last_id   INTEGER NOT NULL
);

-- Single-row snapshot of running herdr sessions for the worker-owned sweep (#1665). lh-worker
-- polls herdr (session list + per-repo agent list) on a global interval, projects the same wire
-- shape terminal/sessions returns, and upserts it here every tick; the RPC then reads this row
-- with zero herdr subprocess spawn. snapshot is the serialized HerdrSessionsWire; signature is the
-- structural digest (agents/status/workspaces, excluding volatile token usage) used to emit a
-- terminal.sessions_updated event only when the displayed state actually changed. captured_at is
-- refreshed whenever the worker publishes a successful snapshot or explicit capture-failure
-- transition, so a frozen value means a stopped worker, not merely an idle herdr. The snapshot's
-- session_list_capture_failed marker distinguishes failure state from confirmed empty state.
CREATE TABLE IF NOT EXISTS herdr_session_snapshots (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot     TEXT NOT NULL,
  signature    TEXT NOT NULL,
  captured_at  TEXT NOT NULL
);

-- Last observed mergeable state per open PR for the worker's conflict sweep (#1232). A
-- clean -> conflict transition (a reviewed PR whose base advanced into a conflict while it waited
-- for a human merge) fires pull_request.merge_conflict once. State is recorded every tick, so once
-- a PR sits in conflict the transition is consumed and the event does not repeat until it goes
-- clean and conflicts again. Kept beside notification_merge_ready_states rather than merged into
-- it: the transition semantics differ (that table counts clean entries; this one detects the
-- clean -> conflict edge).
CREATE TABLE IF NOT EXISTS pull_conflict_states (
  repo_id      INTEGER NOT NULL REFERENCES repos(id),
  pull_number  INTEGER NOT NULL,
  state        TEXT NOT NULL
                 CHECK (state IN ('clean', 'conflict', 'no_commits', 'blocked', 'unknown')),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (repo_id, pull_number)
);

-- workflow definitions (#997). User-editable prompt bundles for the fixed Execute/Verify
-- workflow. A NULL repo_id is global; otherwise the definition is available only to that repo.
CREATE TABLE IF NOT EXISTS workflows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id         INTEGER REFERENCES repos(id),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  execute_prompt  TEXT NOT NULL DEFAULT '',
  verify_prompt   TEXT NOT NULL DEFAULT '',
  archived_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Instance-wide settings whose source of truth must be shared by every process. Values are stored
-- as text and validated by their owning service before writes.
CREATE TABLE IF NOT EXISTS instance_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Runtime identity of the one resident worker sharing this database. The fixed primary key makes
-- each heartbeat replace the previous process generation instead of accumulating health history.
CREATE TABLE IF NOT EXISTS worker_runtime (
  singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
  protocol_version INTEGER NOT NULL,
  started_at       TEXT NOT NULL,
  heartbeat_at     TEXT NOT NULL
);

-- Minimal run tracking for the workflow delete guard (#997) plus the run lifecycle state. A
-- workflow referenced by an active run cannot be deleted.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id        INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
  repo_id            INTEGER NOT NULL REFERENCES repos(id),
  issue_number       INTEGER NOT NULL,
  pr_number          INTEGER NOT NULL,
  status             TEXT NOT NULL,
  current_step       TEXT NOT NULL,
  rework_count       INTEGER NOT NULL DEFAULT 0,
  auto_mode          INTEGER NOT NULL DEFAULT 0,
  -- Runtime + model resolved for the parent at start, so every step inherits the same values a
  -- human/config selected (#516/#594). Nullable: rows written before these columns fall back to
  -- claude-code + the config default model when read.
  runtime            TEXT,
  model              TEXT,
  -- Fixed contract language captured when the run starts. Existing rows and databases default to
  -- English so an instance setting change cannot alter an in-progress or historical run.
  contract_language  TEXT NOT NULL DEFAULT 'en',
  parent_session_id  TEXT,
  step_sessions_json TEXT NOT NULL DEFAULT '{}',
  -- Child most recently launched or explicitly reactivated for live pane input. Kept separate from
  -- current_step because continuing Execute work after a fresh pass leaves lifecycle at Verify.
  active_step        TEXT,
  active_session_id  TEXT,
  child_sequence     INTEGER NOT NULL DEFAULT 0,
  -- Durable worker bookmark for workflow instruction delivery. A restarted worker resumes after
  -- the last event whose instruction was delivered; the parent never manages this cursor.
  event_cursor       INTEGER NOT NULL DEFAULT 0,
  -- Snapshot the configured per-interval allowance when the run starts. The current cumulative
  -- limit advances only through the explicit cost-limit increase operation.
  cost_increment_usd REAL NOT NULL,
  cost_limit_usd     REAL NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  -- Set once when the run leaves the running lifecycle. Unlike updated_at, this does not move when
  -- terminal-run maintenance advances an event cursor.
  ended_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_status
  ON workflow_runs(workflow_id, status);

-- Durable idempotency receipts for non-transactional parent side effects. A pending row means the
-- parent stopped in the ambiguous window after claiming an effect; replay must surface it for human
-- recovery instead of automatically repeating Esc, pane input, or a human notification.
CREATE TABLE IF NOT EXISTS workflow_event_effects (
  run_id      INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  effect      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, event_id, effect)
);

-- Retired artifact-contract tables (#1358). The Workflow moved to pointer inputs and
-- HEAD/review observation: step outputs are commits / PR reviews / attachments / comments, so
-- nothing reads or writes workflow_artifacts / workflow_placements / workflow_step_pins /
-- workflow_artifact_submitters anymore. Existing databases keep those tables untouched as
-- inert history (a new run's progress never consults them); they are simply no longer created
-- on fresh installs. The transient placement-claim lock table is dropped by a migration.
`;

/**
 * Open (creating if needed) the LoopHub database at `path`: connection pragmas, the current base
 * schema, then any migration this database has not recorded yet.
 */
export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const opened = new Db(path);
  opened.exec("PRAGMA journal_mode = WAL;");
  opened.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES};`);
  opened.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  opened.exec("PRAGMA foreign_keys = ON;");
  opened.exec(SCHEMA);
  runMigrations(opened);
  return opened;
}

export const db = openDb(dbPath());

export function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
