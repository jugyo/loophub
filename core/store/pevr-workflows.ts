import { db, now } from "../db.ts";

export interface PevrWorkflowInput {
  name: string;
  description: string;
  planPrompt: string;
  executePrompt: string;
  verifyPrompt: string;
  reflectPrompt: string;
}

export interface PevrWorkflowRow {
  id: number;
  name: string;
  description: string;
  plan_prompt: string;
  execute_prompt: string;
  verify_prompt: string;
  reflect_prompt: string;
  created_at: string;
  updated_at: string;
}

export function listPevrWorkflows(): PevrWorkflowRow[] {
  return db
    .query(`SELECT * FROM pevr_workflows ORDER BY name COLLATE NOCASE, id`)
    .all() as PevrWorkflowRow[];
}

export function getPevrWorkflowByName(name: string): PevrWorkflowRow | null {
  return db
    .query(`SELECT * FROM pevr_workflows WHERE name = ?`)
    .get(name) as PevrWorkflowRow | null;
}

export function getPevrWorkflowById(id: number): PevrWorkflowRow | null {
  return db
    .query(`SELECT * FROM pevr_workflows WHERE id = ?`)
    .get(id) as PevrWorkflowRow | null;
}

export function createPevrWorkflow(input: PevrWorkflowInput): PevrWorkflowRow {
  const t = now();
  return db
    .query(
      `INSERT INTO pevr_workflows
        (name, description, plan_prompt, execute_prompt, verify_prompt, reflect_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.name,
      input.description,
      input.planPrompt,
      input.executePrompt,
      input.verifyPrompt,
      input.reflectPrompt,
      t,
      t,
    ) as PevrWorkflowRow;
}

export function updatePevrWorkflow(
  id: number,
  patch: Partial<PevrWorkflowInput>,
): PevrWorkflowRow | null {
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
  if (patch.planPrompt !== undefined) {
    sets.push("plan_prompt = ?");
    params.push(patch.planPrompt);
  }
  if (patch.executePrompt !== undefined) {
    sets.push("execute_prompt = ?");
    params.push(patch.executePrompt);
  }
  if (patch.verifyPrompt !== undefined) {
    sets.push("verify_prompt = ?");
    params.push(patch.verifyPrompt);
  }
  if (patch.reflectPrompt !== undefined) {
    sets.push("reflect_prompt = ?");
    params.push(patch.reflectPrompt);
  }
  sets.push("updated_at = ?");
  params.push(now(), id);
  db.run(`UPDATE pevr_workflows SET ${sets.join(", ")} WHERE id = ?`, params);
  return getPevrWorkflowById(id);
}

export function deletePevrWorkflow(id: number): void {
  db.run(`DELETE FROM pevr_workflows WHERE id = ?`, [id]);
}

export function countActivePevrRunsForWorkflow(workflowId: number): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count
       FROM pevr_runs
       WHERE workflow_id = ? AND status IN ('running', 'blocked')`,
    )
    .get(workflowId) as { count: number } | null;
  return row?.count ?? 0;
}

export interface PevrRunInput {
  workflowId: number;
  repoId: number;
  issueNumber: number;
  prNumber: number;
  status: string;
  currentStep: string;
  parentSessionId?: string | null;
}

export interface PevrRunRow {
  id: number;
  workflow_id: number | null;
  repo_id: number;
  issue_number: number;
  pr_number: number;
  status: string;
  current_step: string;
  rework_count: number;
  parent_session_id: string | null;
  step_sessions_json: string;
  created_at: string;
  updated_at: string;
}

export function createPevrRun(input: PevrRunInput): PevrRunRow {
  const t = now();
  return db
    .query(
      `INSERT INTO pevr_runs
        (workflow_id, repo_id, issue_number, pr_number, status, current_step, parent_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.workflowId,
      input.repoId,
      input.issueNumber,
      input.prNumber,
      input.status,
      input.currentStep,
      input.parentSessionId ?? null,
      t,
      t,
    ) as PevrRunRow;
}

export function getPevrRun(id: number): PevrRunRow | null {
  return db
    .query(`SELECT * FROM pevr_runs WHERE id = ?`)
    .get(id) as PevrRunRow | null;
}
