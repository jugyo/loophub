import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before db.ts runs its import-time setup (see store.test.ts).
const HOME = mkdtempSync(join(tmpdir(), "lh-db-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let D: typeof import("./db.ts");

beforeAll(async () => {
  D = await import("./db.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("busy_timeout is set so concurrent writers wait instead of failing immediately", () => {
  // A non-zero busy_timeout is what makes a write block (up to N ms) for another
  // process's write lock rather than throwing SQLITE_BUSY ("database is locked").
  const row = D.db.query("PRAGMA busy_timeout").get() as { timeout: number };
  expect(row.timeout).toBe(5000);
});

test("WAL journal mode is preserved alongside busy_timeout", () => {
  const row = D.db.query("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  expect(row.journal_mode.toLowerCase()).toBe("wal");
});

test("journal_size_limit caps the WAL after a checkpoint", () => {
  const limit = D.db.query("PRAGMA journal_size_limit").get() as {
    journal_size_limit: number;
  };
  expect(limit.journal_size_limit).toBe(8 * 1024 * 1024);

  D.db.exec("CREATE TABLE wal_size_test (payload BLOB NOT NULL)");
  D.db.exec("BEGIN");
  for (let i = 0; i < 12; i++) {
    D.db.run("INSERT INTO wal_size_test VALUES (zeroblob(1048576))");
  }
  D.db.exec("COMMIT");
  D.db.query("PRAGMA wal_checkpoint(RESTART)").get();
  // RESTART makes the next writer reset the WAL; that reset is when SQLite
  // applies journal_size_limit to the existing file.
  D.db.run("INSERT INTO wal_size_test VALUES (zeroblob(1))");

  expect(statSync(`${process.env.LOOPHUB_DB}-wal`).size).toBeLessThanOrEqual(
    limit.journal_size_limit,
  );
});

test("the retired issue group schema is absent on a fresh database", () => {
  // Its removal is migration 002; re-running the whole list is covered in migrations.test.ts.
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

test("the retired Inbox schema is absent on a fresh database", () => {
  const names = D.db
    .query(
      `SELECT name FROM sqlite_schema
       WHERE name IN ('inbox_messages', 'idx_inbox_messages_repo_state')`,
    )
    .all() as { name: string }[];
  expect(names).toEqual([]);
});

test("the retired scheduled-task schema is retained for stored data", () => {
  const names = (
    D.db
      .query(
        `SELECT name FROM sqlite_schema
         WHERE name IN ('scheduled_tasks', 'scheduled_task_runs')
         ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  expect(names).toEqual(["scheduled_task_runs", "scheduled_tasks"]);
});

function explain(sql: string, params: unknown[]): string {
  const rows = D.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
    detail: string;
  }[];
  return rows.map((r) => r.detail).join(" | ");
}

test("events query-optimization indexes exist", () => {
  const names = (
    D.db
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  expect(names).toContain("idx_events_type_id");
  expect(names).toContain("idx_events_repo_ready_number_id");
  expect(names).toContain("idx_events_repo_cost_stopped_number_session_id");
  expect(names).toContain("idx_events_repo_workflow_run_id");
});

test("notification signal sweep (type + id range, no repo_id) uses idx_events_type_id", () => {
  // Mirrors store/notifications.ts listNotificationSignalRows, which scans a bounded id
  // range for one event type (inlined as a literal, not a bound param) at a time across all
  // repos.
  const plan = explain(
    `SELECT e.id FROM events e WHERE e.type = 'dev.cost_stopped' AND e.id > ? AND e.id <= ?`,
    [0, 1000],
  );
  expect(plan).toContain("idx_events_type_id");
});

// The real store/events.ts queries below all inline the event type as a SQL literal
// (e.g. `type = 'dev.cost_stopped'`), never as a bound `?` parameter — SQLite's partial-index
// matching only recognizes the index's WHERE condition when the query's own type filter is a
// literal, so these tests mirror that exact shape rather than parameterizing type.

test("firstReadyForReviewAt's repo_id+number+ORDER BY id lookup uses the ready_for_review partial index", () => {
  // Mirrors store/events.ts firstReadyForReviewAt (bare `payload`).
  expect(
    explain(
      `SELECT created_at FROM events WHERE repo_id = ? AND type = 'pull_request.ready_for_review' AND json_extract(payload, '$.number') = ? ORDER BY id ASC LIMIT 1`,
      [1, 5],
    ),
  ).toContain("idx_events_repo_ready_number_id");
});

test("hasCostStopEvent / hasAnyCostStopEvent use the cost_stopped partial index", () => {
  // Mirrors store/events.ts hasCostStopEvent (bare `payload`, + session_id).
  expect(
    explain(
      `SELECT 1 FROM events WHERE repo_id = ? AND type = 'dev.cost_stopped' AND json_extract(payload, '$.number') = ? AND json_extract(payload, '$.session_id') = ? LIMIT 1`,
      [1, 5, "sess-1"],
    ),
  ).toContain("idx_events_repo_cost_stopped_number_session_id");

  // Mirrors store/events.ts hasAnyCostStopEvent (bare `payload`, no session_id).
  expect(
    explain(
      `SELECT 1 FROM events WHERE repo_id = ? AND type = 'dev.cost_stopped' AND json_extract(payload, '$.number') = ? LIMIT 1`,
      [1, 5],
    ),
  ).toContain("idx_events_repo_cost_stopped_number_session_id");
});

test("eventsForWorkflowRun seeks the workflow run-id partial index", () => {
  // Mirrors store/events.ts eventsForWorkflowRun. Unlike the single-type indexes above, this
  // partial index covers a type family, so the query has to repeat the same GLOB pair.
  expect(
    explain(
      `SELECT * FROM events
       WHERE repo_id = ?
         AND (type GLOB 'workflow_run.*'
           OR type GLOB 'workflow_step.*')
         AND CAST(json_extract(payload, '$.id') AS INTEGER) = ?
       ORDER BY id ASC`,
      [1, 5],
    ),
  ).toContain("idx_events_repo_workflow_run_id");
});

test("workflowRunObservationTrail seeks the workflow run-id partial index", () => {
  // Mirrors store/events.ts workflowRunObservationTrail. UNION ALL keeps the lifecycle
  // predicate independent from the review-source attempt window, so the lifecycle branch can
  // use the same expression-index shape as eventsForWorkflowRun.
  const plan = explain(
    `SELECT * FROM events
     WHERE repo_id = ?
       AND (type GLOB 'workflow_run.*' OR type GLOB 'workflow_step.*')
       AND CAST(json_extract(payload, '$.id') AS INTEGER) = ?
     UNION ALL
     SELECT * FROM events
     WHERE repo_id = ?
       AND type = 'pull_request.review_submitted'
       AND json_extract(payload, '$.number') = ?
       AND json_extract(payload, '$.source_payload_version') = ?
       AND id > ? AND id < ?
     ORDER BY id ASC`,
    [1, 5, 1, 7, 1, 10, 20],
  );
  expect(plan).toContain("idx_events_repo_workflow_run_id");
});

test("workflowRunObservationTrail latency for an issue-list-sized run set", () => {
  D.db.run(
    `INSERT INTO repos (full_name, name, owner, local_path, default_branch, created_at)
     VALUES ('me/issue-list-benchmark', 'issue-list-benchmark', 'me', '/tmp/issue-list-benchmark', 'main', '2026-01-01T00:00:00.000Z')`,
  );
  const insert = (type: string, payload: string) =>
    D.db.run(
      `INSERT INTO events (repo_id, type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      [1, type, "test", payload],
    );
  for (let i = 0; i < 39_000; i++) {
    insert("issue.updated", JSON.stringify({ number: i }));
  }
  for (let run = 1; run <= 152; run++) {
    for (let step = 0; step < 10; step++) {
      insert(
        step === 0 ? "workflow_run.started" : "workflow_step.completed",
        JSON.stringify({ id: run }),
      );
    }
  }

  const oldSql = `SELECT * FROM events
    WHERE repo_id = ?
      AND (((type GLOB 'workflow_run.*' OR type GLOB 'workflow_step.*')
        AND json_extract(payload, '$.id') = ?)
        OR (type = 'pull_request.review_submitted'
          AND json_extract(payload, '$.number') = ?
          AND json_extract(payload, '$.source_payload_version') = ?
          AND id > ? AND id < ?))
    ORDER BY id ASC`;
  const newSql = `SELECT * FROM events
    WHERE repo_id = ?
      AND (type GLOB 'workflow_run.*' OR type GLOB 'workflow_step.*')
      AND CAST(json_extract(payload, '$.id') AS INTEGER) = ?
    UNION ALL
    SELECT * FROM events
    WHERE repo_id = ? AND type = 'pull_request.review_submitted'
      AND json_extract(payload, '$.number') = ?
      AND json_extract(payload, '$.source_payload_version') = ?
      AND id > ? AND id < ?
    ORDER BY id ASC`;
  const oldParams = [1, 75, 75, 1, 0, Number.MAX_SAFE_INTEGER];
  const newParams = [1, 75, 1, 75, 1, 0, Number.MAX_SAFE_INTEGER];
  const plan = (sql: string, params: unknown[]) =>
    (
      D.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
        detail: string;
      }[]
    ).map((row) => row.detail);
  const averageMs = (sql: string, params: unknown[]) => {
    const query = D.db.query(sql);
    const started = performance.now();
    for (let i = 0; i < 200; i++) query.all(...params);
    return (performance.now() - started) / 200;
  };

  const oldPlan = plan(oldSql, oldParams);
  const newPlan = plan(newSql, newParams);
  const oldMs = averageMs(oldSql, oldParams);
  const newMs = averageMs(newSql, newParams);
  console.info(
    `issue-list workload: 40,520 events / 152 workflow runs; ` +
      `old plan=${oldPlan.join(" | ")}; new plan=${newPlan.join(" | ")}; ` +
      `old=${oldMs.toFixed(3)}ms; new=${newMs.toFixed(3)}ms`,
  );
  expect(oldPlan.join(" | ")).not.toContain("idx_events_repo_workflow_run_id");
  expect(newPlan.join(" | ")).toContain("idx_events_repo_workflow_run_id");
  expect(newMs).toBeLessThan(oldMs);
});

test("workflowRunsWithPendingEvents seeks the workflow run-id partial index per run", () => {
  // Mirrors store/workflows.ts workflowRunsWithPendingEvents, which the worker's event tail runs
  // once per second. The CAST is what keeps this a seek: the run id comes from workflow_runs.id,
  // an INTEGER-affinity column, and SQLite skips an expression index whose affinity does not
  // match the comparison's — dropping the CAST turns each run into a full scan of the repo's
  // events with no other visible symptom.
  const plan = explain(
    `SELECT run.* FROM workflow_runs run
     WHERE EXISTS (
       SELECT 1 FROM events event
       WHERE event.repo_id = run.repo_id
         AND (event.type GLOB 'workflow_run.*'
           OR event.type GLOB 'workflow_step.*')
         AND CAST(json_extract(event.payload, '$.id') AS INTEGER) = run.id
         AND event.id > run.event_cursor
     )
     ORDER BY run.id`,
    [],
  );
  expect(plan).toContain("idx_events_repo_workflow_run_id");
});
