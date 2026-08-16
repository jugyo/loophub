import type { Db } from "./db.ts";

// Versioned schema migrations for the base schema defined in db.ts.
//
// MIGRATIONS is append-only: add new entries at the end and never renumber, reorder, or edit the
// `id` of an existing one — an id is the ledger key that records "this database already ran that
// step". Editing the body of an already-released migration is equally off-limits; write a new one.
//
// 新しい migration を追加するときは `npm run migration:new -- descriptive-name` を実行する。
// スクリプトが現在の UTC 秒を使った ID と entry の雛形を出力するので、実装した entry を
// この配列の末尾に追加する。数値 prefix、ランダムな suffix、連番は追加せず、ID の重複は
// 作者が解決すべき明示的なエラーとして扱う。
//
// Ledger choice: a `schema_migrations` table keyed by the migration id, not `PRAGMA user_version`.
// Every database that predates this module carries `user_version = 0` while having applied an
// unknown subset of the steps below, so a single monotonic integer cannot express what has already
// run. Per-id rows let such a database converge on first boot (each step is guarded so re-running it
// is a no-op) and record exactly what it applied.
//
// Failures are not swallowed. The retired `tryExec` wrapper hid every error — SQL typos, constraint
// violations, failed backfills — behind "the column probably already existed". Idempotency now comes
// from explicit state guards (`addColumn` / `dropColumn` consult PRAGMA table_info, table rebuilds
// check sqlite_master) so anything unexpected propagates as an exception, per CLAUDE.md's "prefer
// visible errors to automatic recovery".

export interface Migration {
  id: string;
  run: (db: Db) => void;
}

const LEGACY_MIGRATION_ID = /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIMESTAMP_MIGRATION_ID = /^\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIGRATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 新しい migration の ID を作る。
 *
 * migration ID は UTC の秒精度を使い、ランダムな suffix や連番を付けない。同じ秒に別の
 * migration が作られた場合は、宣言側で重複を解決する。
 */
export function createMigrationId(
  name: string,
  now: Date = new Date(),
): string {
  if (!MIGRATION_NAME.test(name)) {
    throw new Error(
      `migration name は lowercase kebab-case で指定してください: ${name}`,
    );
  }
  const timestamp = [
    now.getUTCFullYear().toString().padStart(4, "0"),
    (now.getUTCMonth() + 1).toString().padStart(2, "0"),
    now.getUTCDate().toString().padStart(2, "0"),
    now.getUTCHours().toString().padStart(2, "0"),
    now.getUTCMinutes().toString().padStart(2, "0"),
    now.getUTCSeconds().toString().padStart(2, "0"),
  ].join("");
  return `${timestamp}-${name}`;
}

function validateMigrationIds(migrations: Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (
      !LEGACY_MIGRATION_ID.test(migration.id) &&
      !TIMESTAMP_MIGRATION_ID.test(migration.id)
    ) {
      throw new Error(
        `migration ID が不正です: ${migration.id}; NNN-name または YYYYMMDDHHMMSS-name を指定してください`,
      );
    }
    if (seen.has(migration.id)) {
      throw new Error(`migration ID が重複しています: ${migration.id}`);
    }
    seen.add(migration.id);
  }
}

function columnExists(db: Db, table: string, column: string): boolean {
  // PRAGMA table_info of an unknown table returns no rows rather than raising.
  return (
    db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).some((c) => c.name === column);
}

function tableExists(db: Db, table: string): boolean {
  return Boolean(
    db
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table),
  );
}

function addColumnIfMissing(
  db: Db,
  table: string,
  column: string,
  definition: string,
): void {
  if (columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// SQLite rewrites the whole table on DROP COLUMN, so skipping an already-absent column also keeps
// the convergence pass of a fully-migrated database cheap.
function dropColumnIfPresent(db: Db, table: string, column: string): void {
  if (!columnExists(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

/** A migration made of plain statements whose own `IF EXISTS` / `OR IGNORE` makes it idempotent. */
function sql(id: string, statements: string): Migration {
  return { id, run: (db) => db.exec(statements) };
}

/** `ALTER TABLE <table> ADD COLUMN <column> <definition>`, skipped when the column is present. */
function addColumn(
  id: string,
  table: string,
  column: string,
  definition: string,
): Migration {
  return { id, run: (db) => addColumnIfMissing(db, table, column, definition) };
}

/** `ALTER TABLE <table> DROP COLUMN <column>`, skipped when the column is already gone. */
function dropColumn(id: string, table: string, column: string): Migration {
  return { id, run: (db) => dropColumnIfPresent(db, table, column) };
}

export const MIGRATIONS: Migration[] = [
  // Seed the monotonic Issue/PR allocator for existing repositories. Opened events are durable after
  // an Issue or PR row is hard-deleted, so migration must consider both current rows and that
  // history. `ON CONFLICT ... max(...)` never lowers a mark that a partially-upgraded database
  // already seeded.
  sql(
    "001-seed-repo-number-sequences",
    `
    INSERT INTO repo_number_sequences (repo_id, last_number)
    SELECT r.id,
           max(
             COALESCE((
               SELECT MAX(i.number)
               FROM issues i
               WHERE i.repo_id = r.id
             ), 0),
             COALESCE((
               SELECT MAX(
                 CASE WHEN json_valid(e.payload)
                   THEN CAST(json_extract(e.payload, '$.number') AS INTEGER)
                   ELSE 0
                 END
               )
               FROM events e
               WHERE e.repo_id = r.id
                 AND e.type IN ('issue.opened', 'pull_request.opened')
             ), 0)
           )
    FROM repos r
    WHERE true
    ON CONFLICT(repo_id) DO UPDATE SET
      last_number = max(repo_number_sequences.last_number, excluded.last_number);
  `,
  ),

  // Issue groups were retired in #911. Existing databases may still carry their bolt-on tables;
  // discard that obsolete data instead of preserving or converting it. Drop the membership table
  // first because it references both issue_groups and issues. The tables' dedicated indexes are
  // removed automatically with their owning tables.
  sql(
    "002-drop-retired-issue-groups",
    `
    DROP TABLE IF EXISTS issue_group_members;
    DROP TABLE IF EXISTS issue_groups;
  `,
  ),

  // Persistent Issue/PR substring index (#1400). node:sqlite's bundled SQLite does not include
  // FTS5, so store one-, two-, and three-character grams in a normal indexed table. Search uses the
  // longest available grams to narrow candidates, then SQLite verifies the exact substring against
  // issues. The table is created here rather than in the base schema so the backfill below stays
  // attached to its creation.
  {
    id: "003-create-issue-search-grams",
    run: (db) => {
      if (tableExists(db, "issue_search_grams")) return;
      db.exec(`
        CREATE TABLE issue_search_grams (
          issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          gram TEXT NOT NULL,
          PRIMARY KEY (issue_id, gram)
        );
        CREATE INDEX idx_issue_search_grams_gram_issue
          ON issue_search_grams(gram, issue_id);
        WITH RECURSIVE
          source(issue_id, text) AS (
            SELECT id, lower(title) FROM issues
            UNION ALL
            SELECT id, lower(body) FROM issues
          ),
          grams(issue_id, text, position, length) AS (
            SELECT issue_id, text, 1, 1 FROM source
            UNION ALL
            SELECT issue_id, text,
                   CASE WHEN length = 3 THEN position + 1 ELSE position END,
                   CASE WHEN length = 3 THEN 1 ELSE length + 1 END
            FROM grams
            WHERE position + CASE WHEN length = 3 THEN 1 ELSE 0 END <= length(text)
          )
        INSERT OR IGNORE INTO issue_search_grams(issue_id, gram)
        SELECT issue_id, substr(text, position, length)
        FROM grams
        WHERE position + length - 1 <= length(text);
      `);
    },
  },

  // Migrate the New Issue-specific registry (#670) into the generic pane/resource model. Silently
  // dropping one legacy association would be worse than making an operator address a visible
  // startup error, so this must not be tolerant. Fresh databases never create the retired table.
  {
    id: "004-migrate-issue-herdr-panes",
    run: (db) => {
      if (!tableExists(db, "issue_herdr_panes")) return;
      db.exec(`
        INSERT INTO herdr_panes
          (repo_id, launch_id, pane_id, session_name, display_name, origin, created_at, updated_at)
        SELECT repo_id, launch_id, pane_id, session_name, 'New issue', 'issue-create',
               created_at, updated_at
        FROM issue_herdr_panes;
        INSERT INTO herdr_pane_resources
          (pane_id, resource_kind, resource_key, created_at)
        SELECT p.id, 'issue', CAST(legacy.issue_id AS TEXT), legacy.created_at
        FROM issue_herdr_panes legacy
        JOIN herdr_panes p
          ON p.repo_id = legacy.repo_id AND p.launch_id = legacy.launch_id
        WHERE legacy.issue_id IS NOT NULL;
        DROP TABLE issue_herdr_panes;
      `);
    },
  },

  // Resource relationships make navigation intent explicit. Existing New Issue links predate the
  // column but have an unambiguous origin, so preserve them as filed-from associations; every other
  // historical link remains the generic related relationship.
  {
    id: "005-herdr-pane-resources-relationship",
    run: (db) => {
      addColumnIfMissing(
        db,
        "herdr_pane_resources",
        "relationship",
        "TEXT NOT NULL DEFAULT 'related'",
      );
      db.exec(
        `UPDATE herdr_pane_resources
         SET relationship = 'filed-from'
         WHERE relationship = 'related'
           AND resource_kind = 'issue'
           AND pane_id IN (SELECT id FROM herdr_panes WHERE origin = 'issue-create')`,
      );
    },
  },

  // #1142 replaces the ready-for-review `implementation_done` alert with a true merge-ready
  // transition. SQLite cannot alter a CHECK constraint in place, so rebuild this small derived table
  // once and discard legacy implementation alerts: those rows were produced by the retired signal
  // and do not prove that their PRs were actually merge-ready.
  {
    id: "006-notifications-merge-ready-kind",
    run: (db) => {
      const table = db
        .query(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`,
        )
        .get() as { sql: string } | null;
      if (!table || table.sql.includes("'merge_ready'")) return;
      db.exec(`
        ALTER TABLE notifications RENAME TO notifications_legacy;
        CREATE TABLE notifications (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id         INTEGER NOT NULL REFERENCES repos(id),
          kind            TEXT NOT NULL
                            CHECK (kind IN ('merge_ready', 'over_budget', 'human_attention')),
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          resource_kind   TEXT NOT NULL CHECK (resource_kind IN ('issue', 'pull', 'repo')),
          resource_number INTEGER,
          source_key      TEXT NOT NULL UNIQUE,
          herdr_pane_id   TEXT,
          read_at         TEXT,
          created_at      TEXT NOT NULL
        );
        INSERT INTO notifications
          (id, repo_id, kind, title, body, resource_kind, resource_number, source_key,
           herdr_pane_id, read_at, created_at)
        SELECT id, repo_id, kind, title, body, resource_kind, resource_number, source_key,
               herdr_pane_id, read_at, created_at
        FROM notifications_legacy
        WHERE kind IN ('over_budget', 'human_attention');
        DROP TABLE notifications_legacy;
        CREATE INDEX idx_notifications_read_created
          ON notifications(read_at, created_at, id);
        CREATE INDEX idx_notifications_repo ON notifications(repo_id, id);
      `);
    },
  },

  addColumn("007-pulls-head-sha", "pulls", "head_sha", "TEXT"),
  addColumn("008-pulls-base-sha", "pulls", "base_sha", "TEXT"),
  // Durable provenance for a conventional branch recorded before its first worktree exists. Legacy
  // rows default to initialized/strict; only new launcher-managed PRs (Workflow / openPr) opt into
  // pending creation.
  addColumn(
    "009-pulls-head-pending-creation",
    "pulls",
    "head_pending_creation",
    "INTEGER NOT NULL DEFAULT 0",
  ),
  addColumn(
    "010-workflow-runs-auto-mode",
    "workflow_runs",
    "auto_mode",
    "INTEGER NOT NULL DEFAULT 0",
  ),
  addColumn("011-workflow-runs-runtime", "workflow_runs", "runtime", "TEXT"),
  addColumn("012-workflow-runs-model", "workflow_runs", "model", "TEXT"),
  addColumn(
    "013-workflow-runs-contract-language",
    "workflow_runs",
    "contract_language",
    "TEXT NOT NULL DEFAULT 'en'",
  ),
  addColumn(
    "014-workflow-runs-child-sequence",
    "workflow_runs",
    "child_sequence",
    "INTEGER NOT NULL DEFAULT 0",
  ),
  // Durable workflow event bookmark. Existing rows start at 0 so the current delivery mechanism can
  // reconcile their history from the same persisted position.
  addColumn(
    "015-workflow-runs-event-cursor",
    "workflow_runs",
    "event_cursor",
    "INTEGER NOT NULL DEFAULT 0",
  ),
  // Human-wait marker (#1307): non-NULL means the run is waiting for an explicit human instruction
  // while staying `running` (resumable); the text is the reason shown to the human. Legacy terminal
  // `blocked` rows keep their status and never carry a reason.
  addColumn(
    "016-workflow-runs-needs-human-reason",
    "workflow_runs",
    "needs_human_reason",
    "TEXT",
  ),
  addColumn(
    "017-workflow-runs-active-step",
    "workflow_runs",
    "active_step",
    "TEXT",
  ),
  addColumn(
    "018-workflow-runs-active-session-id",
    "workflow_runs",
    "active_session_id",
    "TEXT",
  ),
  // Nullable here even though the base schema declares both NOT NULL: SQLite cannot add a NOT NULL
  // column without a default, and there is no sensible default budget to invent for legacy rows.
  addColumn(
    "019-workflow-runs-cost-increment-usd",
    "workflow_runs",
    "cost_increment_usd",
    "REAL",
  ),
  addColumn(
    "020-workflow-runs-cost-limit-usd",
    "workflow_runs",
    "cost_limit_usd",
    "REAL",
  ),
  // Artifact-contract retirement (#1358): the claims table only ever held transient placement
  // locks, so dropping it loses nothing; the artifact/placement/pin history tables stay untouched.
  sql(
    "021-drop-workflow-placement-claims",
    "DROP TABLE IF EXISTS workflow_placement_claims",
  ),
  addColumn("022-issues-target-branch", "issues", "target_branch", "TEXT"),
  addColumn(
    "023-review-comments-review-id",
    "review_comments",
    "review_id",
    "INTEGER",
  ),
  {
    id: "024-pulls-linked-issue-id",
    run: (db) => {
      addColumnIfMissing(
        db,
        "pulls",
        "linked_issue_id",
        "INTEGER REFERENCES issues(id)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_pulls_linked_issue ON pulls(linked_issue_id)",
      );
    },
  },
  {
    id: "025-repos-archived",
    run: (db) => {
      addColumnIfMissing(db, "repos", "archived", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "repos", "archived_at", "TEXT");
    },
  },
  // repos.merge_mode (#406): which write action the PR detail offers — 'merge' (loophub's internal
  // merge) or 'github_pr' (export to GitHub via the create-PR skill). NULL = unset, so the effective
  // mode falls back to a per-repo default (github_pr when the repo has a GitHub remote, else merge —
  // see core/merge-mode.ts). The two modes are mutually exclusive in the UI.
  addColumn("026-repos-merge-mode", "repos", "merge_mode", "TEXT"),
  // repos.agent_* (#1532): the per-repo Coding agent override. agent_override is the on/off toggle;
  // while on, agent_runtime / agent_model / agent_effort pin the runtime / model / effort a workflow
  // run launches with, otherwise the effective config falls back to the application config.json
  // defaults (codingAgent / agentModel / agentEffort — see core/repo-agent-config.ts). The values are
  // kept even while the toggle is off so flipping it back on restores the prior choices.
  {
    id: "027-repos-agent-override",
    run: (db) => {
      addColumnIfMissing(
        db,
        "repos",
        "agent_override",
        "INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(db, "repos", "agent_runtime", "TEXT");
      addColumnIfMissing(db, "repos", "agent_model", "TEXT");
      addColumnIfMissing(db, "repos", "agent_effort", "TEXT");
    },
  },
  // Converge DBs that ran the intermediate #186 migration (which added a maintained
  // pulls.open_linked_issue_id column + partial unique index as a hard "one open PR per issue"
  // constraint). That approach was dropped in favor of the soft guard so an issue can carry multiple
  // proposal PRs later; remove the now-unmaintained column and index. Drop the index first, so
  // DROP COLUMN is permitted.
  {
    id: "028-drop-pulls-open-linked-issue",
    run: (db) => {
      db.exec("DROP INDEX IF EXISTS idx_pulls_open_linked_issue");
      dropColumnIfPresent(db, "pulls", "open_linked_issue_id");
    },
  },
  {
    id: "029-pulls-changes-addressed",
    run: (db) => {
      addColumnIfMissing(db, "pulls", "changes_addressed_at", "TEXT");
      addColumnIfMissing(db, "pulls", "changes_addressed_by", "TEXT");
    },
  },
  // Pulls are reviewable as soon as they are created. Drop the legacy WIP flag while preserving all
  // other pull data; existing rows therefore continue to read and update as ordinary pull requests.
  dropColumn("030-drop-pulls-draft", "pulls", "draft"),
  // #814: the "undo the immediate main merge" feature (#770) was fully removed; converge DBs that
  // already ran its migration (ADD COLUMN + audit table) back to the pre-feature schema.
  {
    id: "031-drop-main-merge-undo",
    run: (db) => {
      dropColumnIfPresent(db, "pulls", "linked_issue_closed_event_id");
      db.exec(`
        DROP INDEX IF EXISTS idx_main_merge_undos_pr;
        DROP TABLE IF EXISTS main_merge_undos;
      `);
    },
  },
  // reviews.head_sha records the PR head a review was made against, so a PASS
  // can be marked stale once the branch advances past that commit.
  addColumn("032-reviews-head-sha", "reviews", "head_sha", "TEXT"),
  // reviews.topic labelled the review's aspect (e.g. design/bug/style/security) so a
  // single commit could carry several reviews distinguished by topic (#209). The
  // per-topic merge gate it fed was retired in #1934; migration 047 drops the column
  // again. Kept here because MIGRATIONS is append-only.
  addColumn("033-reviews-topic", "reviews", "topic", "TEXT"),
  // reviews.model records the agent/model that produced the review (#1107), so a
  // stored review can be attributed to its author's model. NULL for reviews
  // submitted without a model (all pre-existing rows, and human/untagged reviews).
  addColumn("034-reviews-model", "reviews", "model", "TEXT"),
  // #428: unify the review-verdict vocabulary from "approve" to "pass" (AI
  // reviewers pass/fail a change rather than "approve" it). One-time rewrite of
  // historical rows; new rows are written as PASS directly (core/service.ts still
  // accepts the old "approve" input as a back-compat alias).
  sql(
    "035-reviews-approve-to-pass",
    "UPDATE reviews SET event = 'PASS' WHERE event = 'APPROVE'",
  ),
  // agent_sessions.runtime records which runtime launched the session (e.g. "claude-code") instead
  // of inferring it from the agent label. Pre-existing rows get NULL and rely on the lh-build →
  // claude-code backward-compat fallback (core/session-runtime.ts sessionRuntime).
  addColumn("036-agent-sessions-runtime", "agent_sessions", "runtime", "TEXT"),
  // agent_sessions.kind labels the session's purpose (#298): "dev" / "review" / "issue-create" / …
  // (extensible — stored as a free TEXT, not an enum, so new kinds need no migration). Pre-existing
  // rows get NULL; migration 038 stamps the migrated dev sessions as "dev".
  addColumn("037-agent-sessions-kind", "agent_sessions", "kind", "TEXT"),
  // session_usage.context_usage_percent (#980): max observed current-context usage for a
  // session/model, nullable when the transcript lacks either the context window or current-turn
  // token count.
  {
    id: "038-session-usage-context-usage-percent",
    run: (db) => {
      addColumnIfMissing(db, "session_usage", "context_usage_percent", "REAL");
      addColumnIfMissing(
        db,
        "session_usage_subagents",
        "context_usage_percent",
        "REAL",
      );
    },
  },

  // ---- #316: retire pulls.session_id (and the older issue assignee it migrated from) ----
  //
  // #186 added pulls.session_id as the PR's 1:1 dev-session pointer (backfilled from the retiring
  // issue assignee); #298 generalized attribution into the session_links N:M bridge. The 1:1 pointer
  // is now derivable as "the PR's latest kind='dev' linked session" (store.primaryDevSessionForPull),
  // so #316 retires the column: migrate any legacy value into session_links, then DROP it.
  // Usage attribution/retro derive the anchor from session_links from here on.
  //
  // Guarded on a still-present legacy column so a database that never had either one does not
  // rebuild the pulls/issues tables (SQLite DROP COLUMN rewrites the table). The order matters:
  // backfill into session_links BEFORE dropping the column, so PRs open (or pending retro) at
  // upgrade time keep their attribution.
  {
    id: "039-retire-pulls-session-id",
    run: (db) => {
      const hadAssignee = columnExists(db, "issues", "assignee_session_id");
      if (!columnExists(db, "pulls", "session_id") && !hadAssignee) return;
      // Ensure the column exists so a pre-#186 DB can be backfilled from the retiring assignee.
      addColumnIfMissing(
        db,
        "pulls",
        "session_id",
        "TEXT REFERENCES agent_sessions(id)",
      );
      if (hadAssignee) {
        // (#186) Backfill from the old assignee — prefer the PR's own assignee (direct PR-targeted
        // launch) over the linked issue's (the common issue-targeted launch flow): seed the own-row
        // value, then the linked-issue value for rows still NULL.
        db.exec(
          `UPDATE pulls SET session_id = (SELECT assignee_session_id FROM issues WHERE issues.id = pulls.issue_id)
           WHERE session_id IS NULL
             AND (SELECT assignee_session_id FROM issues WHERE issues.id = pulls.issue_id) IS NOT NULL`,
        );
        db.exec(
          `UPDATE pulls SET session_id = (SELECT assignee_session_id FROM issues WHERE issues.id = pulls.linked_issue_id)
           WHERE session_id IS NULL AND linked_issue_id IS NOT NULL
             AND (SELECT assignee_session_id FROM issues WHERE issues.id = pulls.linked_issue_id) IS NOT NULL`,
        );
        // Drop the retired assignee column and its unique index (index first, so DROP COLUMN is
        // permitted).
        db.exec("DROP INDEX IF EXISTS idx_issues_assignee_session");
        dropColumnIfPresent(db, "issues", "assignee_session_id");
      }
      // (#298) Mirror every PR's dev session into session_links (kind='dev') before the column
      // drops, so usage attribution/retro keep resolving it. INSERT OR IGNORE is idempotent
      // (PK is the pair)
      // and preserves any link a newer build already wrote. INNER JOIN agent_sessions (not LEFT):
      // session_links.session_id has an FK to agent_sessions and foreign_keys is ON; an FK violation
      // is NOT suppressed by OR IGNORE and would abort the whole INSERT...SELECT. A pre-#298
      // pulls.session_id could point at an unregistered session, so a LEFT JOIN would emit such an
      // orphan row and fail the ENTIRE backfill. The INNER JOIN drops orphans up front;
      // s.created_at is then always present.
      db.exec(
        `INSERT OR IGNORE INTO session_links (session_id, issue_id, created_at)
         SELECT pulls.session_id, pulls.issue_id, s.created_at
         FROM pulls
         JOIN agent_sessions s ON s.id = pulls.session_id
         WHERE pulls.session_id IS NOT NULL`,
      );
      db.exec(
        `UPDATE agent_sessions SET kind = 'dev'
         WHERE kind IS NULL
           AND id IN (SELECT session_id FROM pulls WHERE session_id IS NOT NULL)`,
      );
      // (#316) The pointer now lives in session_links; drop the denormalized column.
      dropColumnIfPresent(db, "pulls", "session_id");
    },
  },

  sql("040-drop-review-notes", "DROP TABLE IF EXISTS review_notes"),

  // repos.favorite (#457): user-marked "quick access" flag for a repo, surfaced in the repo list UI
  // (sorted first) independent of archived state. favorited_at is a companion nullable timestamp, set
  // when the flag flips on and cleared when it flips off, mirroring the archived/archived_at pairing.
  {
    id: "041-repos-favorite",
    run: (db) => {
      addColumnIfMissing(db, "repos", "favorite", "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "repos", "favorited_at", "TEXT");
    },
  },

  // issues.closed_at (#456): stamped once, only at the open->closed transition (core/store.ts
  // updateIssue), unlike updated_at which every field edit bumps (title/body/state alike). Needed as
  // a stable "closed at" anchor for the PR work-duration "closed" basis (serialize.ts
  // pullWorkDuration) — anchoring to updated_at instead let a later title/body edit on an
  // already-closed PR silently inflate the reported duration. Backfilled once for pre-existing closed
  // rows (best-effort approximation — the real close time isn't recoverable, so updated_at is the
  // closest available signal for rows that predate this column).
  {
    id: "042-issues-closed-at",
    run: (db) => {
      addColumnIfMissing(db, "issues", "closed_at", "TEXT");
      db.exec(
        "UPDATE issues SET closed_at = updated_at WHERE state = 'closed' AND closed_at IS NULL",
      );
    },
  },

  // Herdr pane lifecycle claims (#1330). Existing generic registry rows default to externally
  // managed. New Issue panes are the first managed vertical slice. Backfill one active claim for
  // every still-open Issue association so deploying this schema cannot orphan a live creation pane.
  {
    id: "043-herdr-panes-lifecycle",
    run: (db) => {
      addColumnIfMissing(
        db,
        "herdr_panes",
        "lifecycle_managed",
        "INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_managed IN (0, 1))",
      );
      addColumnIfMissing(db, "herdr_panes", "closed_at", "TEXT");
      db.exec(
        "UPDATE herdr_panes SET lifecycle_managed = 1 WHERE origin = 'issue-create'",
      );
      db.exec(
        `INSERT OR IGNORE INTO herdr_pane_claims
           (pane_id, resource_kind, resource_key, purpose, created_at)
         SELECT p.id, 'issue', r.resource_key, 'issue-create-lifecycle', r.created_at
         FROM herdr_panes p
         JOIN herdr_pane_resources r
           ON r.pane_id = p.id AND r.resource_kind = 'issue'
         JOIN issues i
           ON i.id = CAST(r.resource_key AS INTEGER)
          AND CAST(i.id AS TEXT) = r.resource_key
         WHERE p.origin = 'issue-create' AND i.state = 'open'`,
      );
    },
  },

  // github_pulls.github_merged / github_merged_at (#800): whether the GitHub PR a loophub PR was
  // exported to has since been merged on GitHub, synced periodically by lh-worker (see
  // core/github-merge-sync.ts / worker/maintenance.ts startGithubMergeSweep). Deliberately does not
  // touch the loophub PR's own state/merged columns — recording the fact is this issue's whole
  // scope; flowing it into loophub's own merge/close transition is left to a later issue.
  {
    id: "044-github-pulls-github-merged",
    run: (db) => {
      addColumnIfMissing(
        db,
        "github_pulls",
        "github_merged",
        "INTEGER NOT NULL DEFAULT 0",
      );
      addColumnIfMissing(db, "github_pulls", "github_merged_at", "TEXT");
    },
  },

  // github_pulls.pushed_sha (#848): the loophub-side head SHA last pushed to the GitHub branch —
  // recorded when the export (createGithubPull) or the "push local changes" action (pushGithubPull)
  // pushes. Comparing it against the PR's live head SHA is how the UI tells whether local commits
  // added after the export have not yet reached GitHub (and so whether to offer the push button). Null
  // for links recorded without a push (record-github-pr) or created before this column existed.
  addColumn(
    "045-github-pulls-pushed-sha",
    "github_pulls",
    "pushed_sha",
    "TEXT",
  ),

  // Notification source cursors (#1062 review): when this version first sees an existing DB, seed the
  // cursors to the current history tail so the topbar does not materialize years of old events/reviews
  // as fresh unread notifications. Fresh DBs seed to 0 and then process subsequently-created signals.
  sql(
    "046-seed-notification-cursors",
    `
    INSERT OR IGNORE INTO notification_cursors (scope, last_id)
    SELECT 'events', COALESCE(MAX(id), 0) FROM events;
    INSERT OR IGNORE INTO notification_cursors (scope, last_id)
    SELECT 'reviews', COALESCE(MAX(id), 0) FROM reviews;
  `,
  ),

  // #1934: the merge gate no longer buckets reviews by topic, and topic had no other reader — a
  // label with no defined criteria could block merge forever when no PASS reproduced its exact
  // string. Existing topic values are dropped with the column; they were display-only.
  dropColumn("047-drop-reviews-topic", "reviews", "topic"),

  sql(
    "048-create-diff-feedback",
    `
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
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_diff_feedback_threads_issue
      ON diff_feedback_threads(issue_id);
    CREATE TABLE IF NOT EXISTS diff_feedback_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id   INTEGER NOT NULL REFERENCES diff_feedback_threads(id) ON DELETE CASCADE,
      author      TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_diff_feedback_messages_thread
      ON diff_feedback_messages(thread_id, created_at, id);
  `,
  ),
  {
    id: "049-number-acceptance-criteria",
    run(db) {
      addColumnIfMissing(
        db,
        "acceptance_criteria",
        "number",
        "INTEGER NOT NULL DEFAULT 0",
      );
      db.exec(`
        UPDATE acceptance_criteria
        SET number = (
          SELECT COUNT(*)
          FROM acceptance_criteria AS earlier
          WHERE earlier.issue_id = acceptance_criteria.issue_id
            AND earlier.id <= acceptance_criteria.id
        )
        WHERE number = 0;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_acceptance_criteria_issue_number
          ON acceptance_criteria(issue_id, number);
      `);
    },
  },
  sql(
    "050-simplify-diff-feedback-conversations",
    `
    DROP TABLE IF EXISTS diff_feedback_reactions;
    DROP INDEX IF EXISTS idx_diff_feedback_threads_issue_status;
    DROP INDEX IF EXISTS idx_diff_feedback_threads_issue;
    DROP INDEX IF EXISTS idx_diff_feedback_messages_thread;
    ALTER TABLE diff_feedback_messages RENAME TO diff_feedback_messages_old;
    ALTER TABLE diff_feedback_threads RENAME TO diff_feedback_threads_old;
    CREATE TABLE diff_feedback_threads (
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
      created_at     TEXT NOT NULL
    );
    INSERT INTO diff_feedback_threads
      (id, issue_id, pr_number, base_sha, head_sha, path, original_path, side,
       start_line, end_line, created_by, created_at)
    SELECT id, issue_id, pr_number, base_sha, head_sha, path, original_path, side,
           start_line, end_line, created_by, created_at
    FROM diff_feedback_threads_old;
    CREATE INDEX idx_diff_feedback_threads_issue
      ON diff_feedback_threads(issue_id);
    CREATE TABLE diff_feedback_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id  INTEGER NOT NULL REFERENCES diff_feedback_threads(id) ON DELETE CASCADE,
      author     TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO diff_feedback_messages
      (id, thread_id, author, body, created_at)
    SELECT id, thread_id, author, body, created_at
    FROM diff_feedback_messages_old;
    CREATE INDEX idx_diff_feedback_messages_thread
      ON diff_feedback_messages(thread_id, created_at, id);
    DROP TABLE diff_feedback_messages_old;
    DROP TABLE diff_feedback_threads_old;
  `,
  ),
  sql(
    "051-create-diff-feedback-reactions",
    `
    CREATE TABLE IF NOT EXISTS diff_feedback_reactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  INTEGER NOT NULL REFERENCES diff_feedback_messages(id) ON DELETE CASCADE,
      author      TEXT NOT NULL,
      emoji       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE (message_id, author, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_diff_feedback_reactions_message
      ON diff_feedback_reactions(message_id, created_at, id);
  `,
  ),
  sql(
    "052-classify-comment-authors",
    `
    ALTER TABLE comments RENAME TO comments_old;
    CREATE TABLE comments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id    INTEGER NOT NULL REFERENCES issues(id),
      author      TEXT NOT NULL,
      author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    INSERT INTO comments
      (id, issue_id, author, author_type, body, created_at, updated_at)
    SELECT id, issue_id, author,
           CASE WHEN author = 'me' THEN 'human' ELSE 'system' END,
           body, created_at, updated_at
    FROM comments_old;
    DROP TABLE comments_old;
  `,
  ),
  sql(
    "053-create-comment-reactions",
    `
    CREATE TABLE IF NOT EXISTS comment_reactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id  INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      author      TEXT NOT NULL,
      emoji       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE (comment_id, author, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_comment_reactions_comment
      ON comment_reactions(comment_id, created_at, id);
  `,
  ),
  sql(
    "053-single-diff-feedback-reaction",
    `
    ALTER TABLE diff_feedback_reactions RENAME TO diff_feedback_reactions_old;
    CREATE TABLE diff_feedback_reactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  INTEGER NOT NULL REFERENCES diff_feedback_messages(id) ON DELETE CASCADE,
      author      TEXT NOT NULL,
      emoji       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE (message_id, author)
    );
    INSERT INTO diff_feedback_reactions
      (id, message_id, author, emoji, created_at)
    SELECT id, message_id, author, emoji, created_at
    FROM diff_feedback_reactions_old AS reaction
    WHERE id = (
      SELECT MAX(candidate.id)
      FROM diff_feedback_reactions_old AS candidate
      WHERE candidate.message_id = reaction.message_id
        AND candidate.author = reaction.author
    );
    DROP TABLE diff_feedback_reactions_old;
    CREATE INDEX idx_diff_feedback_reactions_message
      ON diff_feedback_reactions(message_id, created_at, id);
  `,
  ),
  {
    id: "054-resolve-diff-feedback",
    run(db) {
      addColumnIfMissing(db, "diff_feedback_threads", "resolved_by", "TEXT");
      addColumnIfMissing(db, "diff_feedback_threads", "resolved_at", "TEXT");
    },
  },
  sql(
    "054-single-comment-reaction",
    `
    ALTER TABLE comment_reactions RENAME TO comment_reactions_old;
    CREATE TABLE comment_reactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id  INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      author      TEXT NOT NULL,
      emoji       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE (comment_id, author)
    );
    INSERT INTO comment_reactions
      (id, comment_id, author, emoji, created_at)
    SELECT id, comment_id, author, emoji, created_at
    FROM comment_reactions_old AS reaction
    WHERE id = (
      SELECT MAX(candidate.id)
      FROM comment_reactions_old AS candidate
      WHERE candidate.comment_id = reaction.comment_id
        AND candidate.author = reaction.author
    );
    DROP TABLE comment_reactions_old;
    CREATE INDEX idx_comment_reactions_comment
      ON comment_reactions(comment_id, created_at, id);
  `,
  ),
  sql(
    "055-diff-feedback-locations",
    `
    DROP TABLE IF EXISTS diff_feedback_locations;
    CREATE TABLE diff_feedback_locations (
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
  `,
  ),
  sql(
    "056-agent-execution-targets",
    `
    CREATE TABLE IF NOT EXISTS agent_execution_targets (
      session_id  TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
      provider    TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      context     TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `,
  ),
  // Explicit readiness signal from the parent agent (#2156). A registered pane only proves the pane
  // exists, not that the agent behind it reads its input yet, so an instruction delivered while the
  // agent was still starting was written to a terminal nothing was reading and was lost.
  // Every run that exists when this migration runs was launched under the older prompt and will
  // never send the signal, so backfill those rows from created_at: only runs started afterward —
  // whose launch prompt asks for it — wait for the signal.
  {
    id: "057-workflow-runs-parent-ready-at",
    run(db) {
      addColumnIfMissing(db, "workflow_runs", "parent_ready_at", "TEXT");
      db.exec(
        `UPDATE workflow_runs SET parent_ready_at = created_at WHERE parent_ready_at IS NULL`,
      );
    },
  },
  // Persist whether readiness was serialized before any instruction claim. Timestamps are only
  // second-precision, so equality cannot establish order; existing rows with a receipt at or before
  // readiness remain unconfirmed and surface the ambiguity through the existing error path.
  {
    id: "058-workflow-runs-parent-ready-confirmed",
    run(db) {
      addColumnIfMissing(
        db,
        "workflow_runs",
        "parent_ready_confirmed",
        "INTEGER NOT NULL DEFAULT 0",
      );
      db.exec(`
        UPDATE workflow_runs AS run
        SET parent_ready_confirmed = 1
        WHERE parent_ready_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM workflow_event_effects AS effect
            WHERE effect.run_id = run.id
              AND effect.effect GLOB 'workflow.instruction:*'
              AND effect.created_at <= run.parent_ready_at
          )
      `);
    },
  },
  addColumn(
    "059-notifications-severity",
    "notifications",
    "severity",
    "TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning'))",
  ),
  sql(
    "060-review-responses",
    `
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
  `,
  ),
  {
    id: "061-comment-author-types",
    run(db) {
      addColumnIfMissing(
        db,
        "review_comments",
        "author_type",
        "TEXT NOT NULL DEFAULT 'system' CHECK (author_type IN ('human', 'agent', 'system'))",
      );
      addColumnIfMissing(
        db,
        "diff_feedback_threads",
        "created_by_type",
        "TEXT NOT NULL DEFAULT 'system' CHECK (created_by_type IN ('human', 'agent', 'system'))",
      );
      addColumnIfMissing(
        db,
        "diff_feedback_messages",
        "author_type",
        "TEXT NOT NULL DEFAULT 'system' CHECK (author_type IN ('human', 'agent', 'system'))",
      );

      // Historical rows have no session id, but the session ledger is still a trustworthy record
      // of which stored actor names belonged to humans or coding agents. Ambiguous/unattributed
      // names intentionally remain `system` instead of being guessed from their appearance.
      for (const [table, authorColumn, typeColumn] of [
        ["comments", "author", "author_type"],
        ["review_comments", "author", "author_type"],
        ["diff_feedback_threads", "created_by", "created_by_type"],
        ["diff_feedback_messages", "author", "author_type"],
      ] as const) {
        db.exec(`
          UPDATE ${table}
          SET ${typeColumn} = CASE
            WHEN EXISTS (
              SELECT 1 FROM agent_sessions session
              WHERE session.agent = 'me'
                AND COALESCE(NULLIF(session.name, ''), session.agent) = ${table}.${authorColumn}
            ) AND NOT EXISTS (
              SELECT 1 FROM agent_sessions session
              WHERE session.agent <> 'me'
                AND COALESCE(NULLIF(session.name, ''), session.agent) = ${table}.${authorColumn}
            ) THEN 'human'
            WHEN EXISTS (
              SELECT 1 FROM agent_sessions session
              WHERE session.agent <> 'me'
                AND COALESCE(NULLIF(session.name, ''), session.agent) = ${table}.${authorColumn}
            ) AND NOT EXISTS (
              SELECT 1 FROM agent_sessions session
              WHERE session.agent = 'me'
                AND COALESCE(NULLIF(session.name, ''), session.agent) = ${table}.${authorColumn}
            ) THEN 'agent'
            ELSE 'system'
          END
          WHERE ${typeColumn} = 'system'
        `);
      }
    },
  },
  {
    id: "062-review-author-types",
    run(db) {
      addColumnIfMissing(
        db,
        "reviews",
        "author_type",
        "TEXT NOT NULL DEFAULT 'system' CHECK (author_type IN ('human', 'agent', 'system'))",
      );
      db.exec(`
        UPDATE reviews
        SET author_type = CASE
          WHEN model IS NOT NULL THEN 'agent'
          WHEN EXISTS (
            SELECT 1 FROM agent_sessions session
            WHERE session.agent = 'me'
              AND COALESCE(NULLIF(session.name, ''), session.agent) = reviews.author
          ) AND NOT EXISTS (
            SELECT 1 FROM agent_sessions session
            WHERE session.agent <> 'me'
              AND COALESCE(NULLIF(session.name, ''), session.agent) = reviews.author
          ) THEN 'human'
          WHEN EXISTS (
            SELECT 1 FROM agent_sessions session
            WHERE session.agent <> 'me'
              AND COALESCE(NULLIF(session.name, ''), session.agent) = reviews.author
          ) AND NOT EXISTS (
            SELECT 1 FROM agent_sessions session
            WHERE session.agent = 'me'
              AND COALESCE(NULLIF(session.name, ''), session.agent) = reviews.author
          ) THEN 'agent'
          ELSE 'system'
        END
        WHERE author_type = 'system'
      `);
    },
  },
  sql(
    "063-create-worker-runtime",
    `
    CREATE TABLE IF NOT EXISTS worker_runtime (
      singleton        INTEGER PRIMARY KEY CHECK (singleton = 1),
      protocol_version INTEGER NOT NULL,
      started_at       TEXT NOT NULL,
      heartbeat_at     TEXT NOT NULL
    );
  `,
  ),
  {
    id: "064-workflows-archived-at",
    run(db) {
      addColumnIfMissing(db, "workflows", "archived_at", "TEXT");
    },
  },
  {
    id: "065-session-usage-sample-cache-read",
    run(db) {
      // The base schema stopped creating both tables when 073 dropped them, so a database created
      // after that reaches this step with nothing to migrate. Each table is guarded on its own
      // because they were introduced separately and a database can hold one without the other. For
      // any database that still carries a table, the outcome is unchanged.
      //
      // Existing samples and persisted rate history both include cache reads and cannot be split
      // after the fact. Discard them instead of briefly inflating the non-cache rate after upgrade.
      if (tableExists(db, "session_usage_samples")) {
        addColumnIfMissing(
          db,
          "session_usage_samples",
          "cache_read_tokens",
          "INTEGER NOT NULL DEFAULT 0",
        );
        addColumnIfMissing(
          db,
          "session_usage_samples",
          "cache_read_delta",
          "INTEGER NOT NULL DEFAULT 0",
        );
        db.exec("DELETE FROM session_usage_samples");
      }
      if (tableExists(db, "session_rate_history")) {
        db.exec("DELETE FROM session_rate_history");
      }
    },
  },
  addColumn("066-pulls-archived-at", "pulls", "archived_at", "TEXT"),
  {
    id: "067-repository-scoped-workflows",
    run(db) {
      if (!columnExists(db, "workflows", "repo_id")) {
        const previousSequence = db
          .query(`SELECT seq FROM sqlite_sequence WHERE name = ?`)
          .get("workflows") as { seq: number } | null;
        db.exec(`
          CREATE TEMP TABLE workflow_run_refs AS
            SELECT id, workflow_id FROM workflow_runs WHERE workflow_id IS NOT NULL;
          CREATE TABLE workflows_scoped (
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
          INSERT INTO workflows_scoped
            (id, name, description, execute_prompt, verify_prompt, archived_at, created_at, updated_at)
          SELECT id, name, description, execute_prompt, verify_prompt, archived_at, created_at, updated_at
          FROM workflows;
          DROP TABLE workflows;
          ALTER TABLE workflows_scoped RENAME TO workflows;
          UPDATE workflow_runs
          SET workflow_id = (
            SELECT workflow_id FROM workflow_run_refs WHERE workflow_run_refs.id = workflow_runs.id
          )
          WHERE id IN (SELECT id FROM workflow_run_refs);
          DROP TABLE workflow_run_refs;
        `);
        const currentSequence = db
          .query(`SELECT seq FROM sqlite_sequence WHERE name = ?`)
          .get("workflows") as { seq: number } | null;
        if (previousSequence && !currentSequence) {
          db.run(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`, [
            "workflows",
            previousSequence.seq,
          ]);
        } else if (
          previousSequence &&
          currentSequence &&
          currentSequence.seq < previousSequence.seq
        ) {
          db.run(`UPDATE sqlite_sequence SET seq = ? WHERE name = ?`, [
            previousSequence.seq,
            "workflows",
          ]);
        }
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_global_name
          ON workflows(name) WHERE repo_id IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_repo_name
          ON workflows(repo_id, name) WHERE repo_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_workflows_repo_active
          ON workflows(repo_id, archived_at, name COLLATE NOCASE, id);
      `);
    },
  },
  {
    id: "068-workflow-runs-ended-at",
    run(db) {
      addColumnIfMissing(db, "workflow_runs", "ended_at", "TEXT");
      db.exec(`
        UPDATE workflow_runs
        SET ended_at = updated_at
        WHERE ended_at IS NULL
          AND status IN ('completed', 'stopped', 'blocked')
      `);
    },
  },
  addColumn("069-agent-sessions-model", "agent_sessions", "model", "TEXT"),
  addColumn("070-comments-archived-at", "comments", "archived_at", "TEXT"),
  // Archive replaces resolve on a diff feedback conversation (#2346). The two states meant the same
  // thing in practice — "this conversation is done, stop bringing it to Execute" — so a resolved
  // thread carries its timestamp over instead of being reset to active. `resolved_by` is dropped
  // without a home: nothing read it.
  {
    id: "071-diff-feedback-archive",
    run(db) {
      addColumnIfMissing(db, "diff_feedback_threads", "archived_at", "TEXT");
      if (columnExists(db, "diff_feedback_threads", "resolved_at")) {
        db.exec(
          `UPDATE diff_feedback_threads
           SET archived_at = resolved_at
           WHERE archived_at IS NULL AND resolved_at IS NOT NULL`,
        );
      }
      dropColumnIfPresent(db, "diff_feedback_threads", "resolved_by");
      dropColumnIfPresent(db, "diff_feedback_threads", "resolved_at");
    },
  },
  // Existing notifications stay without a run: their signals are gone from the cursor range, and a
  // reader can still open the resource the notification points at.
  addColumn(
    "072-notifications-workflow-run",
    "notifications",
    "workflow_run_id",
    "INTEGER",
  ),
  // Tokens/sec display is gone (#2366), and both tables only ever fed it: the samples were the
  // rate's raw input and the history was its persisted time series. Neither is worth carrying.
  sql(
    "073-drop-token-rate-tables",
    `
    DROP INDEX IF EXISTS idx_session_rate_history_time;
    DROP TABLE IF EXISTS session_rate_history;
    DROP INDEX IF EXISTS idx_session_usage_samples_session_time;
    DROP TABLE IF EXISTS session_usage_samples;
  `,
  ),
  // Existing reviews stay without a session: nothing recorded which one produced them, so they
  // report no duration rather than a reconstructed guess (#2387). The REFERENCES clause matches
  // what core/db.ts declares for a fresh database, so a migrated one enforces the same key —
  // SQLite accepts it on ADD COLUMN because the column is nullable and defaults to NULL.
  addColumn(
    "074-reviews-session",
    "reviews",
    "session_id",
    "TEXT REFERENCES agent_sessions(id)",
  ),
  // #16: agent-authored PR comments / diff-feedback messages create `agent_comment` notifications.
  // Existing DBs still have the old kind CHECK without that value, so INSERT would fail until the
  // constraint is widened. SQLite cannot ALTER CHECK in place, so rebuild the small derived table
  // once and keep every current kind's rows. Fresh DBs already create the widened CHECK from
  // core/db.ts and skip this step when sqlite_master already mentions agent_comment.
  {
    id: "075-notifications-agent-comment-kind",
    run: (db) => {
      const table = db
        .query(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`,
        )
        .get() as { sql: string } | null;
      if (!table || table.sql.includes("'agent_comment'")) return;
      db.exec(`
        ALTER TABLE notifications RENAME TO notifications_legacy;
        CREATE TABLE notifications (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id         INTEGER NOT NULL REFERENCES repos(id),
          kind            TEXT NOT NULL
                            CHECK (kind IN ('merge_ready', 'over_budget', 'human_attention', 'agent_comment')),
          severity        TEXT NOT NULL DEFAULT 'info'
                            CHECK (severity IN ('info', 'warning')),
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          resource_kind   TEXT NOT NULL CHECK (resource_kind IN ('issue', 'pull', 'repo')),
          resource_number INTEGER,
          source_key      TEXT NOT NULL UNIQUE,
          herdr_pane_id   TEXT,
          workflow_run_id INTEGER,
          read_at         TEXT,
          created_at      TEXT NOT NULL
        );
        INSERT INTO notifications
          (id, repo_id, kind, severity, title, body, resource_kind, resource_number, source_key,
           herdr_pane_id, workflow_run_id, read_at, created_at)
        SELECT id, repo_id, kind,
               COALESCE(severity, 'info'),
               title, body, resource_kind, resource_number, source_key,
               herdr_pane_id, workflow_run_id, read_at, created_at
        FROM notifications_legacy;
        DROP TABLE notifications_legacy;
        CREATE INDEX idx_notifications_read_created
          ON notifications(read_at, created_at, id);
        CREATE INDEX idx_notifications_repo ON notifications(repo_id, id);
      `);
    },
  },
  // #21: drop the notifications.kind SQLite CHECK. Kind validation is code-only
  // (NOTIFICATION_KINDS / createNotification / service assertKind) so adding a kind no longer
  // needs a table rebuild. Keep every existing row; only the constraint is removed.
  // Fresh DBs already create kind without CHECK from core/db.ts and skip when sqlite_master
  // no longer contains CHECK (kind IN ...).
  {
    id: "076-notifications-drop-kind-check",
    run: (db) => {
      const table = db
        .query(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`,
        )
        .get() as { sql: string } | null;
      if (!table?.sql.includes("CHECK (kind IN")) return;
      db.exec(`
        ALTER TABLE notifications RENAME TO notifications_legacy;
        CREATE TABLE notifications (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id         INTEGER NOT NULL REFERENCES repos(id),
          kind            TEXT NOT NULL,
          severity        TEXT NOT NULL DEFAULT 'info'
                            CHECK (severity IN ('info', 'warning')),
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          resource_kind   TEXT NOT NULL CHECK (resource_kind IN ('issue', 'pull', 'repo')),
          resource_number INTEGER,
          source_key      TEXT NOT NULL UNIQUE,
          herdr_pane_id   TEXT,
          workflow_run_id INTEGER,
          read_at         TEXT,
          created_at      TEXT NOT NULL
        );
        INSERT INTO notifications
          (id, repo_id, kind, severity, title, body, resource_kind, resource_number, source_key,
           herdr_pane_id, workflow_run_id, read_at, created_at)
        SELECT id, repo_id, kind,
               COALESCE(severity, 'info'),
               title, body, resource_kind, resource_number, source_key,
               herdr_pane_id, workflow_run_id, read_at, created_at
        FROM notifications_legacy;
        DROP TABLE notifications_legacy;
        CREATE INDEX idx_notifications_read_created
          ON notifications(read_at, created_at, id);
        CREATE INDEX idx_notifications_repo ON notifications(repo_id, id);
      `);
    },
  },
  // github_pulls now carries the export's status, not just its result (#2383): the row is created
  // when the export starts and only identifies a GitHub PR once one exists. That makes number/url
  // nullable and adds a CHECK, neither of which SQLite can alter in place, so the table is rebuilt.
  // Every existing row is a recorded link by definition, so it migrates to 'linked' with linked_at
  // taken from created_at — the closest thing those rows have to a "when did it become linked".
  // The columns earlier migrations bolted on (044, 045) are carried across explicitly; this step
  // runs after them, so the table always has them by the time it is rebuilt.
  {
    id: "077-github-pulls-export-status",
    run: (db) => {
      if (columnExists(db, "github_pulls", "status")) return;
      db.exec(`
        ALTER TABLE github_pulls RENAME TO github_pulls_legacy;
        CREATE TABLE github_pulls (
          issue_id         INTEGER PRIMARY KEY REFERENCES issues(id),
          status           TEXT NOT NULL CHECK (status IN ('creating', 'linked')),
          number           INTEGER,
          url              TEXT,
          branch           TEXT,
          created_by       TEXT,
          created_at       TEXT NOT NULL,
          linked_at        TEXT,
          github_merged    INTEGER NOT NULL DEFAULT 0,
          github_merged_at TEXT,
          pushed_sha       TEXT,
          CHECK (status = 'creating' OR (number IS NOT NULL AND url IS NOT NULL))
        );
        INSERT INTO github_pulls
          (issue_id, status, number, url, branch, created_by, created_at, linked_at,
           github_merged, github_merged_at, pushed_sha)
        SELECT issue_id, 'linked', number, url, branch, created_by, created_at, created_at,
               github_merged, github_merged_at, pushed_sha
        FROM github_pulls_legacy;
        DROP TABLE github_pulls_legacy;
      `);
    },
  },
  // Per-repo additional text appended to the "Create PR on GitHub" agent prompt (#2422). NULL /
  // empty means the launch uses only the default template in core/workflow/github-pr-export-prompt.ts.
  addColumn(
    "078-repos-github-pr-export-extra-prompt",
    "repos",
    "github_pr_export_extra_prompt",
    "TEXT",
  ),
  sql(
    "079-create-pull-status-projection",
    `
    CREATE TABLE IF NOT EXISTS pull_status_projection (
      base_sha       TEXT NOT NULL,
      head_sha       TEXT NOT NULL,
      mergeable      INTEGER CHECK (mergeable IS NULL OR mergeable IN (0, 1)),
      mergeable_state TEXT NOT NULL,
      additions      INTEGER NOT NULL,
      deletions      INTEGER NOT NULL,
      changed_files  INTEGER NOT NULL,
      commits_ahead  INTEGER NOT NULL,
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (base_sha, head_sha)
    );
  `,
  ),
  addColumn(
    "080-pull-status-projection-signals",
    "pull_status_projection",
    "has_effective_diff",
    "INTEGER NOT NULL DEFAULT 0",
  ),
  addColumn(
    "081-pull-status-projection-conflict",
    "pull_status_projection",
    "conflict",
    "INTEGER NOT NULL DEFAULT 0",
  ),
  sql(
    "082-create-pull-diff-projection",
    `
    CREATE TABLE IF NOT EXISTS pull_diff_projection (
      issue_id    INTEGER PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
      base_sha    TEXT NOT NULL,
      head_sha    TEXT NOT NULL,
      files_json  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    `,
  ),
  sql(
    "083-create-jobs",
    `
    CREATE TABLE IF NOT EXISTS jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      type          TEXT NOT NULL,
      repo_id       INTEGER REFERENCES repos(id),
      dedupe_key    TEXT NOT NULL UNIQUE,
      params        TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
      result        TEXT,
      error         TEXT,
      created_at    TEXT NOT NULL,
      started_at    TEXT,
      heartbeat_at  TEXT,
      finished_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at, id);
    `,
  ),
  addColumn("084-repos-origin-branch", "repos", "origin_branch", "TEXT"),
  addColumn("085-repos-origin-ahead", "repos", "origin_ahead", "INTEGER"),
  addColumn("086-repos-origin-behind", "repos", "origin_behind", "INTEGER"),
  addColumn(
    "087-workflow-runs-rework-limit",
    "workflow_runs",
    "rework_limit",
    "INTEGER NOT NULL DEFAULT 8",
  ),
  {
    id: "20260814095613-workflow-runs-effort",
    run: (db) => {
      addColumnIfMissing(db, "workflow_runs", "effort", "TEXT");
      addColumnIfMissing(db, "agent_sessions", "effort", "TEXT");
    },
  },
  sql(
    "20260814130000-pull-status-current-projection",
    `
    CREATE TABLE IF NOT EXISTS pull_status_current_projection (
      issue_id          INTEGER PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
      base_sha          TEXT NOT NULL,
      head_sha          TEXT NOT NULL,
      mergeable         INTEGER CHECK (mergeable IS NULL OR mergeable IN (0, 1)),
      mergeable_state   TEXT NOT NULL,
      has_effective_diff INTEGER NOT NULL,
      conflict          INTEGER NOT NULL,
      additions         INTEGER NOT NULL,
      deletions         INTEGER NOT NULL,
      changed_files     INTEGER NOT NULL,
      commits_ahead     INTEGER NOT NULL,
      base_commits_behind INTEGER NOT NULL,
      updated_at        TEXT NOT NULL
    );
    `,
  ),
  {
    id: "20260815194735-invalid-review-head-shas",
    run: (db) => {
      db.exec(`
        UPDATE reviews
        SET head_sha = NULL
        WHERE head_sha IS NOT NULL
          AND (length(head_sha) <> 40 OR head_sha GLOB '*[^0-9A-Fa-f]*');
      `);
    },
  },
  {
    id: "20260815201510-workflow-step-launch-reservation",
    run: (db) => {
      addColumnIfMissing(db, "workflow_runs", "launching_step", "TEXT");
      addColumnIfMissing(db, "workflow_runs", "launching_session_id", "TEXT");
      addColumnIfMissing(db, "workflow_runs", "launching_head_sha", "TEXT");
      addColumnIfMissing(db, "workflow_runs", "active_head_sha", "TEXT");
      addColumnIfMissing(db, "workflow_runs", "launch_failure_step", "TEXT");
      addColumnIfMissing(
        db,
        "workflow_runs",
        "launch_failure_session_id",
        "TEXT",
      );
      addColumnIfMissing(
        db,
        "workflow_runs",
        "launch_failure_head_sha",
        "TEXT",
      );
      addColumnIfMissing(db, "workflow_runs", "launch_failed_at", "TEXT");
      db.exec(`
        UPDATE workflow_runs AS run
        SET active_head_sha = (
          SELECT json_extract(event.payload, '$.head_sha')
          FROM events AS event
          WHERE event.repo_id = run.repo_id
            AND event.type = 'workflow_step.launched'
            AND json_extract(event.payload, '$.id') = run.id
            AND json_extract(event.payload, '$.step') = 'verify'
            AND json_extract(event.payload, '$.session_id') = run.active_session_id
          ORDER BY event.id DESC
          LIMIT 1
        )
        WHERE run.active_step = 'verify'
          AND run.active_session_id IS NOT NULL
          AND run.active_head_sha IS NULL;
      `);
    },
  },
];

const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);`;

function isApplied(db: Db, id: string): boolean {
  return Boolean(
    db.query("SELECT 1 FROM schema_migrations WHERE id = ?").get(id),
  );
}

/**
 * Apply every migration this database has not recorded yet, and return the ids that ran.
 *
 * Each migration is applied together with its ledger row in one transaction, so a crash mid-way
 * leaves the database on one side of the step and the ledger agreeing with it. Migrations therefore
 * must not open a transaction of their own.
 */
export function runMigrations(
  db: Db,
  migrations: Migration[] = MIGRATIONS,
): string[] {
  validateMigrationIds(migrations);
  db.exec(LEDGER_SCHEMA);
  // Read the ledger once up front so the steady state (everything applied) costs one query and
  // opens no transaction at all.
  const applied = new Set(
    (
      db.query("SELECT id FROM schema_migrations").all() as { id: string }[]
    ).map((row) => row.id),
  );

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // The snapshot above can be stale: `lh`, lh-web and lh-worker share one database and may all
      // boot into the first post-upgrade convergence pass. BEGIN IMMEDIATE serializes them, so
      // re-reading the ledger here is what makes "check, then apply" atomic — without it the loser
      // of the race would re-run a step and then collide on the ledger's primary key.
      if (isApplied(db, migration.id)) {
        db.exec("COMMIT");
        continue;
      }
      migration.run(db);
      db.run("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", [
        migration.id,
        new Date().toISOString(),
      ]);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite already aborted the transaction in the cases where ROLLBACK itself errors; a
        // failed rollback must not mask the migration failure we are about to report.
      }
      throw new Error(`migration ${migration.id} failed`, { cause: error });
    }
    ran.push(migration.id);
  }
  return ran;
}
