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
  target_branch TEXT,
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
  draft           INTEGER NOT NULL DEFAULT 0,
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
  topic       TEXT,
  model       TEXT,
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

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                TEXT PRIMARY KEY,
  agent             TEXT NOT NULL,
  external_session  TEXT NOT NULL,
  name              TEXT,
  runtime           TEXT,
  kind              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (agent, external_session)
);

-- Generalized session<->target links (#298). A session can relate to any issues row — an
-- issue (kind=issue) OR a PR (kind=pull) — and a single issue/PR can carry many sessions
-- (dev, review, issue-create, ...), so this is a plain many-to-many bridge keyed by the pair.
-- This replaces the old 1:1 pulls.session_id attribution (dropped in #316): the PR's primary dev
-- session — the anchor lh resume/retro resolve from — is now derived as the latest kind='dev' link
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
-- are estimated from samples recorded at usage-sync time.
CREATE TABLE IF NOT EXISTS session_usage_samples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL REFERENCES agent_sessions(id),
  total_tokens INTEGER NOT NULL,
  token_delta  INTEGER NOT NULL,
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
-- volatile conversation so a run's trajectory can be replayed, audited, and evaluated later
-- (lh-build-design.ja.md §6.5; the harness "Observability" layer). Generic on purpose: any
-- orchestration (lh-build today, lh-build the first real user, future skills) records through the
-- same protocol; no lh-build-specific column is required.
--
-- Linkage (the "ref"): a handoff binds to a PR (pr_id, the kind='pull' issues row) and/or its
-- session (session_id), the two anchors lh-build handoffs accumulate on; issue_id is the optional
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
-- model-routing/economics analysis (p.42); cost is free-form JSON text (tokens/latency) the
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
-- authoritative merge signal that drives the "Mark as merged" action).
CREATE TABLE IF NOT EXISTS github_pull_status (
  issue_id   INTEGER PRIMARY KEY REFERENCES issues(id),
  payload    TEXT NOT NULL,
  synced_at  TEXT NOT NULL
);

-- New Issue Herdr pane links (#670). A web New Issue launch creates a Herdr pane before an issue
-- exists, while lh issue create creates the issue from inside that pane later. launch_id is the
-- durable correlation key both sides know; issue_id and pane_id can arrive in either order.
CREATE TABLE IF NOT EXISTS issue_herdr_panes (
  launch_id    TEXT PRIMARY KEY,
  repo_id      INTEGER NOT NULL REFERENCES repos(id),
  issue_id     INTEGER REFERENCES issues(id),
  pane_id      TEXT,
  session_name TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_herdr_panes_issue
  ON issue_herdr_panes(issue_id) WHERE issue_id IS NOT NULL;

-- Scheduled tasks (#880). A repo-scoped, saved prompt that a coding agent (claude-code / codex) runs
-- automatically at one or more times of day. times_json is an array of "HH:MM" local-time strings —
-- each registered time fires once per day (dedup is enforced by scheduled_task_runs.fire_key, not
-- here). model/effort are NULL when unset, resolved at fire time from the per-agent application
-- defaults (core/config.ts agentModel/agentEffort). Deliberately NOT cron: the whole point is a small
-- fixed set of daily times, so a list of times replaces a cron expression (#880 out of scope).
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

-- One row per fire of a scheduled task — meta only (#880; the agent's output body stays on the herdr
-- side, not persisted here). A fire is either 'scheduled' (a registered time arrived, worker sweep) or
-- 'manual' (Run now). fire_key is the dedup key for the once-per-day guarantee: for scheduled fires it
-- is "<local-date>T<HH:MM>" and UNIQUE(task_id, fire_key) makes a second sweep tick for the same
-- time/day throw instead of double-firing; for manual fires it is NULL (SQLite allows many NULLs in a
-- UNIQUE, so Run now is never blocked). status is the launch outcome: 'running' while the herdr launch
-- is in flight, then 'success' (agent pane captured) or 'failure' (error recorded). herdr_tab_id /
-- herdr_pane_id reference the launched herdr tab/pane so a human can find the live output.
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

-- Inbox messages (#958). Repo-scoped human-facing notifications that agents can create from the
-- CLI/API. Source and target are structured JSON so later producers (scheduled tasks, dev loops,
-- external agents) can keep their own provenance fields without schema churn; service validation
-- owns the initial contract. State is a single lifecycle value so later read/archive/delete issues
-- can build on the same row instead of introducing parallel flags.
CREATE TABLE IF NOT EXISTS inbox_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id),
  from_json   TEXT NOT NULL,
  to_json     TEXT,
  label       TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'unread'
                CHECK (state IN ('unread', 'read', 'archived', 'deleted')),
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_messages_repo_state
  ON inbox_messages(repo_id, state, id);

-- Notification center (#1062). Separate from inbox_messages: notifications are topbar alerts
-- about LoopHub state transitions, with a typed resource target and optional Herdr pane action.
CREATE TABLE IF NOT EXISTS notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id        INTEGER NOT NULL REFERENCES repos(id),
  kind           TEXT NOT NULL
                   CHECK (kind IN ('implementation_done', 'over_budget', 'human_attention')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  resource_kind  TEXT NOT NULL CHECK (resource_kind IN ('issue', 'pull', 'repo')),
  resource_number INTEGER,
  source_key     TEXT NOT NULL UNIQUE,
  herdr_pane_id  TEXT,
  read_at        TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_read_created
  ON notifications(read_at, created_at, id);
CREATE INDEX IF NOT EXISTS idx_notifications_repo
  ON notifications(repo_id, id);

CREATE TABLE IF NOT EXISTS notification_cursors (
  scope     TEXT PRIMARY KEY,
  last_id   INTEGER NOT NULL
);

-- workflow definitions (#997). Global, user-editable prompt bundles for the fixed
-- Plan/Execute/Verify/Reflect workflow. Step prompts are plain markdown text; empty strings are
-- valid and mean "use only the built-in step contract".
CREATE TABLE IF NOT EXISTS workflows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  description     TEXT NOT NULL DEFAULT '',
  plan_prompt     TEXT NOT NULL DEFAULT '',
  execute_prompt  TEXT NOT NULL DEFAULT '',
  verify_prompt   TEXT NOT NULL DEFAULT '',
  reflect_prompt  TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Minimal run tracking for the workflow delete guard (#997). Full run start/step/artifact
-- behavior is implemented in later Workflow issues; this table is present now so a workflow referenced
-- by an active run cannot be deleted.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id        INTEGER REFERENCES workflows(id) ON DELETE SET NULL,
  repo_id            INTEGER NOT NULL REFERENCES repos(id),
  issue_number       INTEGER NOT NULL,
  pr_number          INTEGER NOT NULL,
  status             TEXT NOT NULL,
  current_step       TEXT NOT NULL,
  rework_count       INTEGER NOT NULL DEFAULT 0,
  parent_session_id  TEXT,
  step_sessions_json TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_status
  ON workflow_runs(workflow_id, status);

CREATE TABLE IF NOT EXISTS workflow_artifacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES workflow_runs(id),
  step         TEXT NOT NULL,
  type         TEXT NOT NULL,
  content_json TEXT NOT NULL,
  head_sha     TEXT NOT NULL,
  dedupe_key   TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_artifacts_run_step
  ON workflow_artifacts(run_id, step, id);

CREATE TABLE IF NOT EXISTS workflow_placements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL REFERENCES workflow_artifacts(id),
  target_kind TEXT NOT NULL,
  target_ref  TEXT NOT NULL,
  placed_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_placements_artifact
  ON workflow_placements(artifact_id);

CREATE TABLE IF NOT EXISTS workflow_step_pins (
  run_id     INTEGER NOT NULL REFERENCES workflow_runs(id),
  step       TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  head_sha   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step, session_id)
);

CREATE TABLE IF NOT EXISTS workflow_placement_claims (
  artifact_id INTEGER PRIMARY KEY REFERENCES workflow_artifacts(id),
  owner_token TEXT NOT NULL,
  claimed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_artifact_submitters (
  artifact_id INTEGER PRIMARY KEY REFERENCES workflow_artifacts(id),
  session_id  TEXT NOT NULL
);
`);

// 既存 DB 向けの軽量マイグレーション（カラムが既にあれば throw → 無視）
function tryExec(sql: string) {
  try {
    db.exec(sql);
  } catch {}
}

// Whether `table` currently has a column named `column`. Used to gate one-time, churn-prone
// migrations (ADD + backfill + DROP) so a fully-migrated DB doesn't rebuild the table every boot.
function columnExists(table: string, column: string): boolean {
  try {
    return (
      db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).some((c) => c.name === column);
  } catch {
    return false;
  }
}

tryExec("ALTER TABLE pulls ADD COLUMN head_sha TEXT");
tryExec("ALTER TABLE workflow_artifacts ADD COLUMN dedupe_key TEXT");
tryExec("ALTER TABLE workflow_placement_claims ADD COLUMN owner_token TEXT");
tryExec("DROP INDEX IF EXISTS idx_workflow_artifacts_submission");
tryExec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_artifacts_inflight_dedupe ON workflow_artifacts(dedupe_key) WHERE dedupe_key IS NOT NULL",
);
tryExec("ALTER TABLE issues ADD COLUMN target_branch TEXT");
tryExec("ALTER TABLE review_comments ADD COLUMN review_id INTEGER");
tryExec(
  "ALTER TABLE pulls ADD COLUMN linked_issue_id INTEGER REFERENCES issues(id)",
);
tryExec(
  "CREATE INDEX IF NOT EXISTS idx_pulls_linked_issue ON pulls(linked_issue_id)",
);
tryExec("ALTER TABLE repos ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
tryExec("ALTER TABLE repos ADD COLUMN archived_at TEXT");
// repos.merge_mode (#406): which write action the PR detail offers — 'merge' (loophub's internal
// merge) or 'github_pr' (export to GitHub via the create-PR skill). NULL = unset, so the effective
// mode falls back to a per-repo default (github_pr when the repo has a GitHub remote, else merge —
// see core/merge-mode.ts). The two modes are mutually exclusive in the UI.
tryExec("ALTER TABLE repos ADD COLUMN merge_mode TEXT");
// The issue assignee (`@lh-build`, #186) and the denormalized pulls.session_id (#186) it migrated into
// are both retired; their one-time migration into session_links and final column drops are
// consolidated in the guarded block at the end of this migration section (search "#316").
//
// Converge DBs that ran the intermediate #186 migration (which added a maintained
// pulls.open_linked_issue_id column + partial unique index as a hard "one open PR per issue"
// constraint). That approach was dropped in favor of the soft guard so an issue can carry multiple
// proposal PRs later; remove the now-unmaintained column and index. On a fresh DB they never
// existed, so DROP INDEX no-ops and DROP COLUMN throws and is ignored.
tryExec("DROP INDEX IF EXISTS idx_pulls_open_linked_issue");
tryExec("ALTER TABLE pulls DROP COLUMN open_linked_issue_id");
tryExec("ALTER TABLE pulls ADD COLUMN changes_addressed_at TEXT");
tryExec("ALTER TABLE pulls ADD COLUMN changes_addressed_by TEXT");
// pulls.draft (#413): the PR's WIP lifecycle flag. `lh build` opens a PR at the *start* of work, so a
// just-opened PR is not yet reviewable; draft=1 marks "still being worked", flipped to 0 (ready) by
// `lh pr ready-for-review`. Pre-existing PRs (and plain `lh pr create`) default to ready (0).
tryExec("ALTER TABLE pulls ADD COLUMN draft INTEGER NOT NULL DEFAULT 0");
// #814: the "undo the immediate main merge" feature (#770) was fully removed; converge DBs that
// already ran its migration (ADD COLUMN + audit table) back to the pre-feature schema. On a
// fresh DB these never existed, so each DROP no-ops/throws and is ignored.
tryExec("ALTER TABLE pulls DROP COLUMN linked_issue_closed_event_id");
tryExec("DROP INDEX IF EXISTS idx_main_merge_undos_pr");
tryExec("DROP TABLE IF EXISTS main_merge_undos");
// reviews.head_sha records the PR head a review was made against, so a PASS
// can be marked stale once the branch advances past that commit.
tryExec("ALTER TABLE reviews ADD COLUMN head_sha TEXT");
// reviews.topic labels the review's aspect (e.g. design/bug/style/security) so a
// single commit can carry several reviews distinguished by topic (#209). NULL =
// untagged (all pre-existing rows, and reviews submitted without a topic).
tryExec("ALTER TABLE reviews ADD COLUMN topic TEXT");
// reviews.model records the agent/model that produced the review (#1107), so a
// stored review can be attributed to its author's model. NULL for reviews
// submitted without a model (all pre-existing rows, and human/untagged reviews).
tryExec("ALTER TABLE reviews ADD COLUMN model TEXT");
// #428: unify the review-verdict vocabulary from "approve" to "pass" (AI
// reviewers pass/fail a topic rather than "approve" it). One-time rewrite of
// historical rows; new rows are written as PASS directly (core/service.ts still
// accepts the old "approve" input as a back-compat alias).
tryExec("UPDATE reviews SET event = 'PASS' WHERE event = 'APPROVE'");
// agent_sessions.runtime records which runtime launched the session (e.g. "claude-code"), so
// `lh resume` picks the resume command by runtime instead of inferring it from the agent label.
// Pre-existing rows get NULL and rely on the lh-build → claude-code backward-compat fallback
// (core/resume.ts sessionRuntime).
tryExec("ALTER TABLE agent_sessions ADD COLUMN runtime TEXT");
// agent_sessions.kind labels the session's purpose (#298): "dev" / "review" / "issue-create" / …
// (extensible — stored as a free TEXT, not an enum, so new kinds need no migration). Pre-existing
// rows get NULL; the #316 block below stamps the migrated dev sessions as "dev".
tryExec("ALTER TABLE agent_sessions ADD COLUMN kind TEXT");
// session_usage.context_usage_percent (#980): max observed current-context usage for a session/model,
// nullable when the transcript lacks either the context window or current-turn token count.
tryExec("ALTER TABLE session_usage ADD COLUMN context_usage_percent REAL");
tryExec(
  "ALTER TABLE session_usage_subagents ADD COLUMN context_usage_percent REAL",
);

// ---- #316: retire pulls.session_id (and the older issue assignee it migrated from) ----
//
// #186 added pulls.session_id as the PR's 1:1 dev-session pointer (backfilled from the retiring
// issue assignee); #298 generalized attribution into the session_links N:M bridge. The 1:1 pointer
// is now derivable as "the PR's latest kind='dev' linked session" (store.primaryDevSessionForPull),
// so #316 retires the column: migrate any legacy value into session_links, then DROP it. resume/retro
// derive the anchor from session_links from here on.
//
// Guarded on a still-present legacy column so a fully-migrated DB does not rebuild the pulls/issues
// tables (SQLite DROP COLUMN rewrites the table) on every boot. Once both columns are gone the block
// is skipped. The order matters: backfill into session_links BEFORE dropping the column, so PRs open
// (or pending retro) at upgrade time keep their attribution.
if (
  columnExists("pulls", "session_id") ||
  columnExists("issues", "assignee_session_id")
) {
  // Ensure the column exists so a pre-#186 DB can be backfilled from the retiring assignee.
  tryExec(
    "ALTER TABLE pulls ADD COLUMN session_id TEXT REFERENCES agent_sessions(id)",
  );
  // (#186) Backfill from the old assignee — prefer the PR's own assignee (direct `lh build <pr>`) over
  // the linked issue's (the common `lh build <issue>` flow): seed the own-row value, then the
  // linked-issue value for rows still NULL. No-op (and ignored) once the assignee column is gone.
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
  // Drop the retired assignee column and its unique index (index first, so DROP COLUMN is permitted).
  tryExec("DROP INDEX IF EXISTS idx_issues_assignee_session");
  tryExec("ALTER TABLE issues DROP COLUMN assignee_session_id");
  // (#298) Mirror every PR's dev session into session_links (kind='dev') before the column drops, so
  // resume/retro keep resolving it. INSERT OR IGNORE is idempotent (PK is the pair) and preserves any
  // link a newer build already wrote. INNER JOIN agent_sessions (not LEFT): session_links.session_id
  // has an FK to agent_sessions and foreign_keys is ON; an FK violation is NOT suppressed by OR IGNORE
  // and would abort the whole INSERT...SELECT. A pre-#298 pulls.session_id could point at an
  // unregistered session, so a LEFT JOIN would emit such an orphan row and silently (tryExec) skip the
  // ENTIRE backfill. The INNER JOIN drops orphans up front; s.created_at is then always present.
  tryExec(
    `INSERT OR IGNORE INTO session_links (session_id, issue_id, created_at)
     SELECT pulls.session_id, pulls.issue_id, s.created_at
     FROM pulls
     JOIN agent_sessions s ON s.id = pulls.session_id
     WHERE pulls.session_id IS NOT NULL`,
  );
  tryExec(
    `UPDATE agent_sessions SET kind = 'dev'
     WHERE kind IS NULL
       AND id IN (SELECT session_id FROM pulls WHERE session_id IS NOT NULL)`,
  );
  // (#316) The pointer now lives in session_links; drop the denormalized column.
  tryExec("ALTER TABLE pulls DROP COLUMN session_id");
}

tryExec("DROP TABLE IF EXISTS review_notes");

// repos.favorite (#457): user-marked "quick access" flag for a repo, surfaced in the repo list UI
// (sorted first) independent of archived state. favorited_at is a companion nullable timestamp, set
// when the flag flips on and cleared when it flips off, mirroring the archived/archived_at pairing.
tryExec("ALTER TABLE repos ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0");
tryExec("ALTER TABLE repos ADD COLUMN favorited_at TEXT");

// issues.closed_at (#456): stamped once, only at the open->closed transition (core/store.ts
// updateIssue), unlike updated_at which every field edit bumps (title/body/state alike). Needed as
// a stable "closed at" anchor for the PR work-duration "closed" basis (serialize.ts
// pullWorkDuration) — anchoring to updated_at instead let a later title/body edit on an
// already-closed PR silently inflate the reported duration. Backfilled once for pre-existing closed
// rows (best-effort approximation — the real close time isn't recoverable, so updated_at is the
// closest available signal for rows that predate this column).
tryExec("ALTER TABLE issues ADD COLUMN closed_at TEXT");
tryExec(
  "UPDATE issues SET closed_at = updated_at WHERE state = 'closed' AND closed_at IS NULL",
);

// github_pulls.github_merged / github_merged_at (#800): whether the GitHub PR a loophub PR was
// exported to has since been merged on GitHub, synced periodically by lh-worker (see
// core/github-merge-sync.ts / worker/maintenance.ts startGithubMergeSweep). Deliberately does not
// touch the loophub PR's own state/merged columns — recording the fact is this issue's whole
// scope; flowing it into loophub's own merge/close transition is left to a later issue.
tryExec(
  "ALTER TABLE github_pulls ADD COLUMN github_merged INTEGER NOT NULL DEFAULT 0",
);
tryExec("ALTER TABLE github_pulls ADD COLUMN github_merged_at TEXT");

// github_pulls.pushed_sha (#848): the loophub-side head SHA last pushed to the GitHub branch —
// recorded when the export (createGithubPull) or the "push local changes" action (pushGithubPull)
// pushes. Comparing it against the PR's live head SHA is how the UI tells whether local commits
// added after the export have not yet reached GitHub (and so whether to offer the push button). Null
// for links recorded without a push (record-github-pr) or created before this column existed.
tryExec("ALTER TABLE github_pulls ADD COLUMN pushed_sha TEXT");

// Notification source cursors (#1062 review): when this version first sees an existing DB, seed the
// cursors to the current history tail so the topbar does not materialize years of old events/reviews
// as fresh unread notifications. Fresh DBs seed to 0 and then process subsequently-created signals.
tryExec(
  `INSERT OR IGNORE INTO notification_cursors (scope, last_id)
   SELECT 'events', COALESCE(MAX(id), 0) FROM events`,
);
tryExec(
  `INSERT OR IGNORE INTO notification_cursors (scope, last_id)
   SELECT 'reviews', COALESCE(MAX(id), 0) FROM reviews`,
);

export function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
