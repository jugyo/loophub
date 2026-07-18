import { db, now } from "../db.ts";

export interface WorkflowInput {
  name: string;
  description: string;
  executePrompt: string;
  verifyPrompt: string;
}

export interface WorkflowRow {
  id: number;
  name: string;
  description: string;
  execute_prompt: string;
  verify_prompt: string;
  created_at: string;
  updated_at: string;
}

export function listWorkflows(): WorkflowRow[] {
  return db
    .query(`SELECT * FROM workflows ORDER BY name COLLATE NOCASE, id`)
    .all() as WorkflowRow[];
}

export function getWorkflowByName(name: string): WorkflowRow | null {
  return db
    .query(`SELECT * FROM workflows WHERE name = ?`)
    .get(name) as WorkflowRow | null;
}

export function getWorkflowById(id: number): WorkflowRow | null {
  return db
    .query(`SELECT * FROM workflows WHERE id = ?`)
    .get(id) as WorkflowRow | null;
}

export function createWorkflow(input: WorkflowInput): WorkflowRow {
  const t = now();
  return db
    .query(
      `INSERT INTO workflows
        (name, description, execute_prompt, verify_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.name,
      input.description,
      input.executePrompt,
      input.verifyPrompt,
      t,
      t,
    ) as WorkflowRow;
}

export function updateWorkflow(
  id: number,
  patch: Partial<WorkflowInput>,
): WorkflowRow | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    params.push(patch.description);
  }
  if (patch.executePrompt !== undefined) {
    sets.push("execute_prompt = ?");
    params.push(patch.executePrompt);
  }
  if (patch.verifyPrompt !== undefined) {
    sets.push("verify_prompt = ?");
    params.push(patch.verifyPrompt);
  }
  sets.push("updated_at = ?");
  params.push(now(), id);
  db.run(`UPDATE workflows SET ${sets.join(", ")} WHERE id = ?`, params);
  return getWorkflowById(id);
}

export function deleteWorkflow(id: number): void {
  db.run(`DELETE FROM workflows WHERE id = ?`, [id]);
}

// Active means `running` only (#1307) — a run waiting for a human keeps status `running`, so it
// stays active; legacy terminal `blocked` rows do not.
export function countActiveWorkflowRunsForWorkflow(workflowId: number): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count
       FROM workflow_runs
       WHERE workflow_id = ? AND status = 'running'`,
    )
    .get(workflowId) as { count: number } | null;
  return row?.count ?? 0;
}

export interface WorkflowRunInput {
  workflowId: number;
  repoId: number;
  issueNumber: number;
  prNumber: number;
  status: string;
  currentStep: string;
  autoMode?: boolean;
  runtime?: string | null;
  model?: string | null;
  parentSessionId?: string | null;
}

export interface WorkflowRunRow {
  id: number;
  workflow_id: number | null;
  repo_id: number;
  issue_number: number;
  pr_number: number;
  status: string;
  current_step: string;
  rework_count: number;
  auto_mode: number;
  runtime: string | null;
  model: string | null;
  // Non-null while the run waits for an explicit human instruction (#1307); the run stays
  // `running`. NULL on legacy rows and after resume.
  needs_human_reason: string | null;
  parent_session_id: string | null;
  step_sessions_json: string;
  child_sequence: number;
  created_at: string;
  updated_at: string;
}

export function createWorkflowRun(input: WorkflowRunInput): WorkflowRunRow {
  const t = now();
  return db
    .query(
      `INSERT INTO workflow_runs
        (workflow_id, repo_id, issue_number, pr_number, status, current_step, auto_mode, runtime, model, parent_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.workflowId,
      input.repoId,
      input.issueNumber,
      input.prNumber,
      input.status,
      input.currentStep,
      input.autoMode === true ? 1 : 0,
      input.runtime ?? null,
      input.model ?? null,
      input.parentSessionId ?? null,
      t,
      t,
    ) as WorkflowRunRow;
}

export function getWorkflowRun(id: number): WorkflowRunRow | null {
  return db
    .query(`SELECT * FROM workflow_runs WHERE id = ?`)
    .get(id) as WorkflowRunRow | null;
}

// All runs in the `running` status (includes runs already held for a human, needs_human_reason
// set). Consumed by Verify-review attribution (core/service/reviews.ts) to match a review's
// session back to its running run.
export function listRunningWorkflowRuns(): WorkflowRunRow[] {
  return db
    .query(`SELECT * FROM workflow_runs WHERE status = 'running' ORDER BY id`)
    .all() as WorkflowRunRow[];
}

export function runningWorkflowRunForSession(
  repoId: number,
  prNumber: number,
  sessionId: string,
): WorkflowRunRow | null {
  const matches = db
    .query(
      `SELECT * FROM workflow_runs run
       WHERE run.repo_id = ? AND run.pr_number = ? AND run.status = 'running'
         AND (run.parent_session_id = ?
           OR EXISTS (SELECT 1 FROM json_each(run.step_sessions_json, '$.execute') WHERE value = ?)
           OR EXISTS (SELECT 1 FROM json_each(run.step_sessions_json, '$.verify') WHERE value = ?))
       ORDER BY run.id DESC LIMIT 2`,
    )
    .all(repoId, prNumber, sessionId, sessionId, sessionId) as WorkflowRunRow[];
  return matches.length === 1 ? matches[0] : null;
}

// Latest run linked to an issue / PR, used by issue / PR detail to display run state (#1008).
// A run row is the display-state source (workflow design: CLI / UI); ordering by id DESC returns
// the most recent run
// when an issue was re-run (e.g. a fresh run started after an earlier one was stopped).
export function latestWorkflowRunForIssue(
  repoId: number,
  issueNumber: number,
): WorkflowRunRow | null {
  return db
    .query(
      `SELECT * FROM workflow_runs WHERE repo_id = ? AND issue_number = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId, issueNumber) as WorkflowRunRow | null;
}

export function latestWorkflowRunForPull(
  repoId: number,
  prNumber: number,
): WorkflowRunRow | null {
  return db
    .query(
      `SELECT * FROM workflow_runs WHERE repo_id = ? AND pr_number = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId, prNumber) as WorkflowRunRow | null;
}

// The latest still-running Workflow run for a PR, used by the worker conflict sweep to project a
// detected merge conflict into a run-scoped event the parent observes (#1516). Scoped to `running`
// so a conflict on a PR whose run already stopped/completed emits no orphan projection.
export function runningWorkflowRunForPull(
  repoId: number,
  prNumber: number,
): WorkflowRunRow | null {
  return db
    .query(
      `SELECT * FROM workflow_runs
       WHERE repo_id = ? AND pr_number = ? AND status = 'running'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(repoId, prNumber) as WorkflowRunRow | null;
}

export function workflowRunForLegacyParent(
  repoId: number,
  prNumber: number,
  parentSessionPrefix: string,
): WorkflowRunRow | null {
  const matches = db
    .query(
      `SELECT * FROM workflow_runs
       WHERE repo_id = ? AND pr_number = ?
         AND substr(parent_session_id, 1, 8) = ?
       ORDER BY id DESC LIMIT 2`,
    )
    .all(repoId, prNumber, parentSessionPrefix) as WorkflowRunRow[];
  return matches.length === 1 ? matches[0] : null;
}

export function updateWorkflowRun(
  id: number,
  patch: {
    status?: string;
    currentStep?: string;
    reworkCount?: number;
    // string sets the human-wait reason, explicit null clears it (#1307).
    needsHumanReason?: string | null;
  },
): WorkflowRunRow | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.currentStep !== undefined) {
    sets.push("current_step = ?");
    params.push(patch.currentStep);
  }
  if (patch.reworkCount !== undefined) {
    sets.push("rework_count = ?");
    params.push(patch.reworkCount);
  }
  if (patch.needsHumanReason !== undefined) {
    sets.push("needs_human_reason = ?");
    params.push(patch.needsHumanReason);
  }
  sets.push("updated_at = ?");
  params.push(now(), id);
  db.run(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`, params);
  return getWorkflowRun(id);
}

export function appendWorkflowRunStepSession(
  id: number,
  step: string,
  sessionId: string,
): WorkflowRunRow | null {
  const run = getWorkflowRun(id);
  if (!run) return null;
  const parsed = parseStepSessions(run.step_sessions_json);
  const sessions = parsed[step] ?? [];
  parsed[step] = sessions.includes(sessionId)
    ? sessions
    : [...sessions, sessionId];
  db.run(
    `UPDATE workflow_runs SET step_sessions_json = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(parsed), now(), id],
  );
  return getWorkflowRun(id);
}

export function reserveWorkflowRunChildSequence(
  id: number,
  minimumNextSequence: number,
): number | null {
  const row = db
    .query(
      `UPDATE workflow_runs
       SET child_sequence = MAX(child_sequence + 1, ?), updated_at = ?
       WHERE id = ?
       RETURNING child_sequence`,
    )
    .get(minimumNextSequence, now(), id) as { child_sequence: number } | null;
  return row?.child_sequence ?? null;
}

function parseStepSessions(value: string): Record<string, string[]> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string[]> = {};
    for (const [step, sessions] of Object.entries(parsed)) {
      if (!Array.isArray(sessions)) continue;
      out[step] = sessions.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}
