import { randomUUID } from "node:crypto";
import { db, now } from "../db.ts";

export interface WorkflowInput {
  name: string;
  description: string;
  planPrompt: string;
  executePrompt: string;
  verifyPrompt: string;
  reflectPrompt: string;
}

export interface WorkflowRow {
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
  db.run(`UPDATE workflows SET ${sets.join(", ")} WHERE id = ?`, params);
  return getWorkflowById(id);
}

export function deleteWorkflow(id: number): void {
  db.run(`DELETE FROM workflows WHERE id = ?`, [id]);
}

export function countActiveWorkflowRunsForWorkflow(workflowId: number): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count
       FROM workflow_runs
       WHERE workflow_id = ? AND status IN ('running', 'blocked')`,
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
  parent_session_id: string | null;
  step_sessions_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowArtifactRow {
  id: number;
  run_id: number;
  step: string;
  type: string;
  content_json: string;
  head_sha: string;
  dedupe_key: string | null;
  created_at: string;
}

export interface WorkflowPlacementRow {
  id: number;
  artifact_id: number;
  target_kind: string;
  target_ref: string;
  placed_at: string;
}

export function createWorkflowArtifact(input: {
  runId: number;
  step: string;
  type: string;
  contentJson: string;
  headSha: string;
  submittedBy: string;
  dedupeKey: string;
}): WorkflowArtifactRow {
  const created = db
    .query(
      `INSERT INTO workflow_artifacts
        (run_id, step, type, content_json, head_sha, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *`,
    )
    .get(
      input.runId,
      input.step,
      input.type,
      input.contentJson,
      input.headSha,
      input.dedupeKey,
      now(),
    ) as WorkflowArtifactRow | null;
  const artifact =
    created ??
    (db
      .query(`SELECT * FROM workflow_artifacts WHERE dedupe_key = ?`)
      .get(input.dedupeKey) as WorkflowArtifactRow);
  db.run(
    `INSERT INTO workflow_artifact_submitters (artifact_id, session_id)
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [artifact.id, input.submittedBy],
  );
  return artifact;
}

export function getWorkflowArtifactSubmitter(
  artifactId: number,
): string | null {
  const row = db
    .query(
      `SELECT session_id FROM workflow_artifact_submitters WHERE artifact_id = ?`,
    )
    .get(artifactId) as { session_id: string } | null;
  return row?.session_id ?? null;
}

export function latestWorkflowArtifact(
  runId: number,
  step: string,
): WorkflowArtifactRow | null {
  return db
    .query(
      `SELECT * FROM workflow_artifacts WHERE run_id = ? AND step = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(runId, step) as WorkflowArtifactRow | null;
}

export function latestWorkflowArtifactByType(
  runId: number,
  type: string,
): WorkflowArtifactRow | null {
  return db
    .query(
      `SELECT * FROM workflow_artifacts
       WHERE run_id = ? AND type = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(runId, type) as WorkflowArtifactRow | null;
}

export function clearWorkflowArtifactDedupe(artifactId: number): void {
  db.run(`UPDATE workflow_artifacts SET dedupe_key = NULL WHERE id = ?`, [
    artifactId,
  ]);
}

export function claimWorkflowPlacement(artifactId: number): string | null {
  const ownerToken = randomUUID();
  const claimedAt = now();
  const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  db.run(
    `INSERT INTO workflow_placement_claims (artifact_id, owner_token, claimed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(artifact_id) DO UPDATE SET
       owner_token = excluded.owner_token,
       claimed_at = excluded.claimed_at
     WHERE workflow_placement_claims.claimed_at < ?`,
    [artifactId, ownerToken, claimedAt, staleBefore],
  );
  const row = db
    .query(
      `SELECT owner_token FROM workflow_placement_claims WHERE artifact_id = ?`,
    )
    .get(artifactId) as { owner_token: string } | null;
  return row?.owner_token === ownerToken ? ownerToken : null;
}

export function releaseWorkflowPlacementClaim(
  artifactId: number,
  ownerToken: string,
): void {
  db.run(
    `DELETE FROM workflow_placement_claims
     WHERE artifact_id = ? AND owner_token = ?`,
    [artifactId, ownerToken],
  );
}

export function renewWorkflowPlacementClaim(
  artifactId: number,
  ownerToken: string,
): boolean {
  db.run(
    `UPDATE workflow_placement_claims SET claimed_at = ?
     WHERE artifact_id = ? AND owner_token = ?`,
    [now(), artifactId, ownerToken],
  );
  return ownsWorkflowPlacementClaim(artifactId, ownerToken);
}

export function ownsWorkflowPlacementClaim(
  artifactId: number,
  ownerToken: string,
): boolean {
  const row = db
    .query(
      `SELECT owner_token FROM workflow_placement_claims WHERE artifact_id = ?`,
    )
    .get(artifactId) as { owner_token: string } | null;
  return row?.owner_token === ownerToken;
}

export function getWorkflowPlacement(
  artifactId: number,
): WorkflowPlacementRow | null {
  return db
    .query(`SELECT * FROM workflow_placements WHERE artifact_id = ?`)
    .get(artifactId) as WorkflowPlacementRow | null;
}

export function createWorkflowPlacement(
  artifactId: number,
  targetKind: string,
  targetRef: string,
): WorkflowPlacementRow {
  return db
    .query(
      `INSERT INTO workflow_placements (artifact_id, target_kind, target_ref, placed_at)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(artifactId, targetKind, targetRef, now()) as WorkflowPlacementRow;
}

export function setWorkflowStepPin(
  runId: number,
  step: string,
  sessionId: string,
  headSha: string,
): void {
  db.run(
    `INSERT INTO workflow_step_pins (run_id, step, session_id, head_sha, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO NOTHING`,
    [runId, step, sessionId, headSha, now()],
  );
}

export function getWorkflowStepPin(
  runId: number,
  step: string,
  sessionId: string,
): string | null {
  const row = db
    .query(
      `SELECT head_sha FROM workflow_step_pins
       WHERE run_id = ? AND step = ? AND session_id = ?`,
    )
    .get(runId, step, sessionId) as { head_sha: string } | null;
  return row?.head_sha ?? null;
}

export function createWorkflowRun(input: WorkflowRunInput): WorkflowRunRow {
  const t = now();
  return db
    .query(
      `INSERT INTO workflow_runs
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
    ) as WorkflowRunRow;
}

export function getWorkflowRun(id: number): WorkflowRunRow | null {
  return db
    .query(`SELECT * FROM workflow_runs WHERE id = ?`)
    .get(id) as WorkflowRunRow | null;
}

// Latest run linked to an issue / PR, used by issue / PR detail to display run state (#1008).
// A run row is the display-state source (§5.2); ordering by id DESC returns the most recent run
// when an issue was re-run (e.g. after a `blocked` escalation was resolved and restarted).
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

export function updateWorkflowRun(
  id: number,
  patch: {
    status?: string;
    currentStep?: string;
    reworkCount?: number;
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
