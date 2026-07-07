import { db, now } from "../db.ts";

// ---- scheduled tasks (#880) ----
// A repo-scoped, saved prompt a coding agent runs at one or more times of day. All functions here are
// pure store access (no validation / no side effects) — resolution, firing, and event emission live in
// service/scheduled-tasks.ts. times are stored as a JSON array of "HH:MM" local-time strings; the
// serializer parses them back. model/effort are NULL when unset (resolved from config at fire time).
export interface ScheduledTaskInput {
  repoId: number;
  title: string;
  prompt: string;
  agent: string;
  timesJson: string;
  model: string | null;
  effort: string | null;
}

export interface ScheduledTaskRow {
  id: number;
  repo_id: number;
  title: string;
  prompt: string;
  agent: string;
  times_json: string;
  model: string | null;
  effort: string | null;
  created_at: string;
  updated_at: string;
}

export function createScheduledTask(
  input: ScheduledTaskInput,
): ScheduledTaskRow {
  const t = now();
  return db
    .query(
      `INSERT INTO scheduled_tasks
        (repo_id, title, prompt, agent, times_json, model, effort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.repoId,
      input.title,
      input.prompt,
      input.agent,
      input.timesJson,
      input.model,
      input.effort,
      t,
      t,
    ) as ScheduledTaskRow;
}

export function getScheduledTaskById(id: number): ScheduledTaskRow | null {
  return db
    .query(`SELECT * FROM scheduled_tasks WHERE id = ?`)
    .get(id) as ScheduledTaskRow | null;
}

export function listScheduledTasks(repoId: number): ScheduledTaskRow[] {
  return db
    .query(`SELECT * FROM scheduled_tasks WHERE repo_id = ? ORDER BY id DESC`)
    .all(repoId) as ScheduledTaskRow[];
}

// Every task in the DB, across repos — used by the worker sweep, which scans all repos each tick.
export function listAllScheduledTasks(): ScheduledTaskRow[] {
  return db
    .query(`SELECT * FROM scheduled_tasks ORDER BY id`)
    .all() as ScheduledTaskRow[];
}

// Partial update: only the provided fields change; updated_at always bumps. Returns the fresh row.
export function updateScheduledTask(
  id: number,
  patch: Partial<Omit<ScheduledTaskInput, "repoId">>,
): ScheduledTaskRow | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.prompt !== undefined) {
    sets.push("prompt = ?");
    params.push(patch.prompt);
  }
  if (patch.agent !== undefined) {
    sets.push("agent = ?");
    params.push(patch.agent);
  }
  if (patch.timesJson !== undefined) {
    sets.push("times_json = ?");
    params.push(patch.timesJson);
  }
  if (patch.model !== undefined) {
    sets.push("model = ?");
    params.push(patch.model);
  }
  if (patch.effort !== undefined) {
    sets.push("effort = ?");
    params.push(patch.effort);
  }
  sets.push("updated_at = ?");
  params.push(now());
  params.push(id);
  db.run(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = ?`, params);
  return getScheduledTaskById(id);
}

export function deleteScheduledTask(id: number): void {
  db.run(`DELETE FROM scheduled_task_runs WHERE task_id = ?`, [id]);
  db.run(`DELETE FROM scheduled_tasks WHERE id = ?`, [id]);
}

// ---- scheduled task runs (fire log; meta only) ----
export interface ScheduledTaskRunRow {
  id: number;
  task_id: number;
  repo_id: number;
  trigger: string;
  scheduled_time: string | null;
  fire_key: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  herdr_tab_id: string | null;
  herdr_pane_id: string | null;
  error: string | null;
  created_at: string;
}

export interface ScheduledTaskRunInput {
  taskId: number;
  repoId: number;
  trigger: string;
  scheduledTime: string | null;
  fireKey: string | null;
}

// Insert a fresh run row in 'running' status. Throws on a UNIQUE(task_id, fire_key) collision, which
// is exactly how the worker's once-per-day guard works: a second sweep tick for the same time/day
// tries to insert the same fire_key and fails, so the caller treats the throw as "already fired".
export function createScheduledTaskRun(
  input: ScheduledTaskRunInput,
): ScheduledTaskRunRow {
  const t = now();
  return db
    .query(
      `INSERT INTO scheduled_task_runs
        (task_id, repo_id, trigger, scheduled_time, fire_key, started_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?) RETURNING *`,
    )
    .get(
      input.taskId,
      input.repoId,
      input.trigger,
      input.scheduledTime,
      input.fireKey,
      t,
      t,
    ) as ScheduledTaskRunRow;
}

// Finalize a run: set the launch outcome and, when the launch succeeded, the herdr tab/pane refs.
export function finishScheduledTaskRun(
  id: number,
  outcome: {
    status: "success" | "failure";
    herdrTabId?: string | null;
    herdrPaneId?: string | null;
    error?: string | null;
  },
): ScheduledTaskRunRow | null {
  db.run(
    `UPDATE scheduled_task_runs
     SET status = ?, ended_at = ?, herdr_tab_id = ?, herdr_pane_id = ?, error = ?
     WHERE id = ?`,
    [
      outcome.status,
      now(),
      outcome.herdrTabId ?? null,
      outcome.herdrPaneId ?? null,
      outcome.error ?? null,
      id,
    ],
  );
  return db
    .query(`SELECT * FROM scheduled_task_runs WHERE id = ?`)
    .get(id) as ScheduledTaskRunRow | null;
}

export function listScheduledTaskRuns(
  taskId: number,
  limit = 50,
): ScheduledTaskRunRow[] {
  return db
    .query(
      `SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(taskId, limit) as ScheduledTaskRunRow[];
}

// Whether a scheduled fire for this task+fire_key already exists (any status). The UNIQUE index is the
// real guard, but the worker checks this first to avoid a throw on the common already-fired path.
export function scheduledRunExists(taskId: number, fireKey: string): boolean {
  return !!db
    .query(
      `SELECT 1 FROM scheduled_task_runs WHERE task_id = ? AND fire_key = ?`,
    )
    .get(taskId, fireKey);
}
