import { db, now } from "../db.ts";
import type { WorkflowContractLanguage } from "../workflow/contracts.ts";
import { workflowSubjectMatchSql } from "./events.ts";

// The identity columns a run's subject predicate reads, as SQL expressions against `run`.
const RUN_SUBJECT = {
  event: "event",
  run: "run.id",
  pr: "run.pr_number",
  issue: "run.issue_number",
} as const;

/**
 * SQL matching a pull request that is still open and unmerged.
 *
 * Whether a Workflow run has ended is the same question as whether its linked PR is still open and
 * unmerged — closing and merging are human operations, and the fact lives on the PR row. Callers
 * share this fragment rather than each restating the predicate, for the same reason
 * {@link workflowSubjectMatchSql} is shared: two callers that disagree about which runs qualify
 * produce runs one accepts and the other drops.
 *
 * The caller supplies the aliases of the PR's `issues` and `pulls` rows and binds no parameters.
 */
export function openUnmergedPullSql(input: {
  issue: string;
  pull: string;
}): string {
  return `(${input.issue}.state = 'open' AND ${input.pull}.merged = 0)`;
}

export interface WorkflowInput {
  repoId?: number | null;
  name: string;
  description: string;
  executePrompt: string;
  verifyPrompt: string;
}

export interface WorkflowRow {
  id: number;
  repo_id: number | null;
  repo_owner: string | null;
  repo_name: string | null;
  name: string;
  description: string;
  execute_prompt: string;
  verify_prompt: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const WORKFLOW_SELECT = `SELECT workflows.*,
  repos.owner AS repo_owner, repos.name AS repo_name
  FROM workflows LEFT JOIN repos ON repos.id = workflows.repo_id`;

export function listWorkflows(
  input: { repoId?: number | null; applicableToRepoId?: number } = {},
): WorkflowRow[] {
  const scope =
    input.applicableToRepoId !== undefined
      ? `(workflows.repo_id = ? OR (
          workflows.repo_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM workflows AS repository_workflow
            WHERE repository_workflow.repo_id = ?
              AND repository_workflow.archived_at IS NULL
              AND repository_workflow.name = workflows.name
          )
        ))`
      : input.repoId === undefined
        ? `workflows.repo_id IS NULL`
        : input.repoId === null
          ? `workflows.repo_id IS NULL`
          : `workflows.repo_id = ?`;
  const params =
    input.applicableToRepoId !== undefined
      ? [input.applicableToRepoId, input.applicableToRepoId]
      : input.repoId == null
        ? []
        : [input.repoId];
  return db
    .query(
      `${WORKFLOW_SELECT}
       WHERE workflows.archived_at IS NULL AND ${scope}
       ORDER BY workflows.name COLLATE NOCASE,
         CASE WHEN workflows.repo_id IS NULL THEN 0 ELSE 1 END,
         workflows.id`,
    )
    .all(...params) as WorkflowRow[];
}

export function getWorkflowByName(
  name: string,
  repoId: number | null = null,
): WorkflowRow | null {
  return db
    .query(
      `${WORKFLOW_SELECT} WHERE workflows.name = ? AND workflows.repo_id IS ?`,
    )
    .get(name, repoId) as WorkflowRow | null;
}

export function getWorkflowById(id: number): WorkflowRow | null {
  return db
    .query(`${WORKFLOW_SELECT} WHERE workflows.id = ?`)
    .get(id) as WorkflowRow | null;
}

export function createWorkflow(input: WorkflowInput): WorkflowRow {
  const t = now();
  const row = db
    .query(
      `INSERT INTO workflows
        (repo_id, name, description, execute_prompt, verify_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.repoId ?? null,
      input.name,
      input.description,
      input.executePrompt,
      input.verifyPrompt,
      t,
      t,
    ) as Omit<WorkflowRow, "repo_owner" | "repo_name">;
  return getWorkflowById(row.id)!;
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

export function archiveWorkflow(id: number): WorkflowRow | null {
  const t = now();
  db.run(`UPDATE workflows SET archived_at = ?, updated_at = ? WHERE id = ?`, [
    t,
    t,
    id,
  ]);
  return getWorkflowById(id);
}

// Active means the run's linked PR is still open and unmerged: such a run may still launch a child,
// so its workflow's prompts must stay. A run waiting for a human keeps its PR open, so it stays
// active; a run whose PR is gone from the database counts as ended.
export function countActiveWorkflowRunsForWorkflow(workflowId: number): number {
  const row = db
    .query(
      `SELECT COUNT(*) AS count
       FROM workflow_runs run
       JOIN issues pr_issue ON pr_issue.repo_id = run.repo_id
         AND pr_issue.number = run.pr_number AND pr_issue.kind = 'pull'
       JOIN pulls pr ON pr.issue_id = pr_issue.id
       WHERE run.workflow_id = ?
         AND ${openUnmergedPullSql({ issue: "pr_issue", pull: "pr" })}`,
    )
    .get(workflowId) as { count: number } | null;
  return row?.count ?? 0;
}

// Whether one run is still active, by the same predicate the count above uses.
export function isWorkflowRunActive(runId: number): boolean {
  const row = db
    .query(
      `SELECT 1 AS active
       FROM workflow_runs run
       JOIN issues pr_issue ON pr_issue.repo_id = run.repo_id
         AND pr_issue.number = run.pr_number AND pr_issue.kind = 'pull'
       JOIN pulls pr ON pr.issue_id = pr_issue.id
       WHERE run.id = ?
         AND ${openUnmergedPullSql({ issue: "pr_issue", pull: "pr" })}`,
    )
    .get(runId) as { active: number } | null;
  return row !== null;
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
  contractLanguage?: WorkflowContractLanguage;
  parentSessionId?: string | null;
  costIncrementUsd: number;
  costLimitUsd: number;
}

export interface WorkflowRunRow {
  id: number;
  workflow_id: number | null;
  repo_id: number;
  issue_number: number;
  pr_number: number;
  // Fixed at `running` for the life of the run: whether a run has ended is read from its linked PR
  // (see openUnmergedPullSql), not stored here. Legacy rows may still read `completed`, `stopped`
  // or `blocked`, and are kept for history.
  status: string;
  current_step: string;
  rework_count: number;
  auto_mode: number;
  runtime: string | null;
  model: string | null;
  contract_language: string;
  // Non-null while the run waits for an explicit human instruction (#1307); the run stays
  // `running`. NULL on legacy rows and after resume.
  needs_human_reason: string | null;
  parent_session_id: string | null;
  // When the parent agent declared it can read its pane. NULL until that signal arrives, which is
  // what keeps instruction delivery from writing to an agent that has not started reading yet.
  parent_ready_at: string | null;
  // Set only when the readiness write was serialized before any instruction receipt claim.
  parent_ready_confirmed: number;
  step_sessions_json: string;
  // The child pane most recently launched or reactivated for live input. This can intentionally
  // differ from current_step while additional Execute work runs after a fresh Verify pass.
  active_step: string | null;
  active_session_id: string | null;
  child_sequence: number;
  // Internal bookmark of the latest run event whose instruction was delivered by the worker.
  event_cursor: number;
  cost_increment_usd: number | null;
  cost_limit_usd: number | null;
  created_at: string;
  updated_at: string;
  // Legacy lifecycle end, carried by rows that were moved to a terminal status while that write
  // path existed. Nothing writes it now, so it is NULL for every run started since.
  ended_at: string | null;
}

export function createWorkflowRun(input: WorkflowRunInput): WorkflowRunRow {
  const t = now();
  return db
    .query(
      `INSERT INTO workflow_runs
        (workflow_id, repo_id, issue_number, pr_number, status, current_step, auto_mode, runtime, model, contract_language, parent_session_id, cost_increment_usd, cost_limit_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
      input.contractLanguage ?? "en",
      input.parentSessionId ?? null,
      input.costIncrementUsd,
      input.costLimitUsd,
      t,
      t,
    ) as WorkflowRunRow;
}

export function increaseWorkflowRunCostLimit(
  id: number,
  expectedLimitUsd: number,
): { previous_limit_usd: number; current_limit_usd: number } | null {
  const row = db
    .query(
      `UPDATE workflow_runs
       SET cost_limit_usd = cost_limit_usd + cost_increment_usd, updated_at = ?
       WHERE id = ?
         AND status = 'running'
         AND needs_human_reason IS NOT NULL
         AND cost_increment_usd IS NOT NULL
         AND cost_limit_usd = ?
         AND EXISTS (
           SELECT 1 FROM events
           WHERE repo_id = workflow_runs.repo_id
             AND type = 'workflow_run.cost_exceeded'
             AND json_extract(payload, '$.id') = workflow_runs.id
             AND json_extract(payload, '$.limit_usd') = workflow_runs.cost_limit_usd
         )
       RETURNING cost_limit_usd`,
    )
    .get(now(), id, expectedLimitUsd) as { cost_limit_usd: number } | null;
  return row
    ? {
        previous_limit_usd: expectedLimitUsd,
        current_limit_usd: row.cost_limit_usd,
      }
    : null;
}

export function getWorkflowRun(id: number): WorkflowRunRow | null {
  return db
    .query(`SELECT * FROM workflow_runs WHERE id = ?`)
    .get(id) as WorkflowRunRow | null;
}

// Legacy timestamp-only write retained for tests that model rows created before the confirmed
// handshake. Production readiness goes through markWorkflowRunParentReadyIfNoEffect below.
export function markWorkflowRunParentReady(id: number): WorkflowRunRow | null {
  const t = now();
  return db
    .query(
      `UPDATE workflow_runs
       SET parent_ready_at = COALESCE(parent_ready_at, ?), updated_at = ?
       WHERE id = ?
       RETURNING *`,
    )
    .get(t, t, id) as WorkflowRunRow | null;
}

// Linearize the first readiness signal against an instruction claim. If an older worker claims the
// event first, this update leaves readiness unset; if this update wins, any later claim and pane
// write happen after the parent declared itself ready. Repeated confirmed signals keep the original
// timestamp.
export function markWorkflowRunParentReadyIfNoEffect(
  id: number,
  effectPrefix: string,
): WorkflowRunRow | null {
  const t = now();
  return db
    .query(
      `UPDATE workflow_runs
       SET parent_ready_at = COALESCE(parent_ready_at, ?),
           parent_ready_confirmed = 1,
           updated_at = ?
       WHERE id = ?
         AND (parent_ready_confirmed = 1 OR (
           parent_ready_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM workflow_event_effects
             WHERE run_id = ? AND effect GLOB ?
           )
         ))
       RETURNING *`,
    )
    .get(t, t, id, id, `${effectPrefix}*`) as WorkflowRunRow | null;
}

// Move the run event bookmark forward. The guard keeps the cursor monotonic when two consumers race.
export function advanceWorkflowRunEventCursor(
  id: number,
  cursor: number,
): WorkflowRunRow | null {
  return db
    .query(
      `UPDATE workflow_runs
       SET event_cursor = ?, updated_at = ?
       WHERE id = ? AND event_cursor < ?
       RETURNING *`,
    )
    .get(cursor, now(), id, cursor) as WorkflowRunRow | null;
}

// Runs with at least one undelivered subject event. This is intentionally independent of run
// status: the worker advances terminal runs past their remaining events without delivering a
// progression instruction, so a restart does not scan the same terminal history forever.
//
// The `workflow_run.started` bound keeps a run that was already running at the cutover from waking
// on the issue / PR backlog its narrower subscription never had to skip. A run with no started
// event falls back to its cursor here rather than being hidden: this query is a prefilter, and the
// dispatcher resolves the bound again and raises the missing start as a visible error.
export function workflowRunsWithPendingEvents(): WorkflowRunRow[] {
  return db
    .query(
      `SELECT run.* FROM workflow_runs run
       WHERE EXISTS (
         SELECT 1 FROM events event
         WHERE event.repo_id = run.repo_id
           AND event.id > max(run.event_cursor, COALESCE((
             SELECT started.id - 1 FROM events started
             WHERE started.repo_id = run.repo_id
               AND started.type = 'workflow_run.started'
               AND json_extract(started.payload, '$.id') = run.id
             ORDER BY started.id ASC LIMIT 1
           ), 0))
           AND ${workflowSubjectMatchSql(RUN_SUBJECT)}
       )
       ORDER BY run.id`,
    )
    .all() as WorkflowRunRow[];
}

export interface WorkflowEventEffectRow {
  run_id: number;
  event_id: number;
  effect: string;
  status: "pending" | "completed";
  created_at: string;
  updated_at: string;
}

export function pendingWorkflowEventEffect(
  runId: number,
): WorkflowEventEffectRow | null {
  return db
    .query(
      `SELECT * FROM workflow_event_effects
       WHERE run_id = ? AND status = 'pending'
       ORDER BY created_at ASC, event_id ASC, effect ASC
       LIMIT 1`,
    )
    .get(runId) as WorkflowEventEffectRow | null;
}

export function pendingWorkflowEventEffectWithPrefix(
  runId: number,
  prefix: string,
): WorkflowEventEffectRow | null {
  return (
    (db
      .query(
        `SELECT * FROM workflow_event_effects
         WHERE run_id = ? AND status = 'pending' AND effect GLOB ?
         ORDER BY event_id, effect
         LIMIT 1`,
      )
      .get(runId, `${prefix}*`) as WorkflowEventEffectRow | null) ?? null
  );
}

export function getWorkflowEventEffectWithPrefix(
  runId: number,
  eventId: number,
  prefix: string,
): WorkflowEventEffectRow | null {
  return (
    (db
      .query(
        `SELECT * FROM workflow_event_effects
         WHERE run_id = ? AND event_id = ? AND effect GLOB ?
         ORDER BY effect
         LIMIT 1`,
      )
      .get(runId, eventId, `${prefix}*`) as WorkflowEventEffectRow | null) ??
    null
  );
}

export function latestCompletedWorkflowEventEffectWithPrefix(
  runId: number,
  beforeEventId: number,
  prefix: string,
): WorkflowEventEffectRow | null {
  return (
    (db
      .query(
        `SELECT * FROM workflow_event_effects
         WHERE run_id = ? AND event_id < ? AND effect GLOB ?
           AND status = 'completed'
         ORDER BY event_id DESC, effect
         LIMIT 1`,
      )
      .get(
        runId,
        beforeEventId,
        `${prefix}*`,
      ) as WorkflowEventEffectRow | null) ?? null
  );
}

export function getWorkflowEventEffect(
  runId: number,
  eventId: number,
  effect: string,
): WorkflowEventEffectRow | null {
  return (
    (db
      .query(
        `SELECT * FROM workflow_event_effects
         WHERE run_id = ? AND event_id = ? AND effect = ?`,
      )
      .get(runId, eventId, effect) as WorkflowEventEffectRow | null) ?? null
  );
}

// The receipt for one run's interrupt at one cumulative cost limit, whichever
// `workflow_run.cost_exceeded` event claimed it (#1844). Re-emitted events carry new ids but the
// same `limit_usd` and ask for the same single interrupt, so the per-event lookup above would let
// the ones a stopped parent drains after the first hold replay Esc and the pane notification.
export function getWorkflowEventEffectForCostLimit(
  runId: number,
  effect: string,
  limitUsd: number,
): WorkflowEventEffectRow | null {
  return (
    (db
      .query(
        `SELECT receipt.* FROM workflow_event_effects receipt
         JOIN events event ON event.id = receipt.event_id
         WHERE receipt.run_id = ? AND receipt.effect = ?
           AND event.type = 'workflow_run.cost_exceeded'
           AND json_extract(event.payload, '$.limit_usd') = ?
         ORDER BY receipt.event_id ASC
         LIMIT 1`,
      )
      .get(runId, effect, limitUsd) as WorkflowEventEffectRow | null) ?? null
  );
}

/**
 * Which events a receipt may be claimed against.
 *
 * `lifecycle` is the original condition: the run's own events, which are the only ones the cost
 * hold and escalation receipts ever anchor to. Widening it for them would let an unrelated PR event
 * claim a lifecycle effect.
 *
 * `subject` is the wider set the instruction receipt needs, matching exactly what the instruction
 * selector returns. The two share `workflowSubjectMatchSql`, so an event the selector hands the
 * dispatcher can never be one the claim rejects.
 */
export type WorkflowEventEffectScope = "lifecycle" | "subject";

export function beginWorkflowEventEffect(
  runId: number,
  eventId: number,
  effect: string,
  scope: WorkflowEventEffectScope = "lifecycle",
): { row: WorkflowEventEffectRow; acquired: boolean } | null {
  const ownership =
    scope === "subject"
      ? `(${workflowSubjectMatchSql(RUN_SUBJECT)}
           OR (event.type = 'workflow_effect.human_escalation'
             AND json_extract(event.payload, '$.id') = run.id))`
      : `((event.type GLOB 'workflow_run.*'
             OR event.type GLOB 'workflow_step.*'
             OR event.type = 'workflow_effect.human_escalation')
           AND json_extract(event.payload, '$.id') = run.id)`;
  const t = now();
  const inserted = db
    .query(
      `INSERT INTO workflow_event_effects
         (run_id, event_id, effect, status, created_at, updated_at)
       SELECT ?, ?, ?, 'pending', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM workflow_runs run
         JOIN events event ON event.id = ?
         WHERE run.id = ?
           AND event.repo_id = run.repo_id
           AND ${ownership}
       )
       ON CONFLICT(run_id, event_id, effect) DO NOTHING
       RETURNING *`,
    )
    .get(
      runId,
      eventId,
      effect,
      t,
      t,
      eventId,
      runId,
    ) as WorkflowEventEffectRow | null;
  if (inserted) return { row: inserted, acquired: true };
  const existing = getWorkflowEventEffect(runId, eventId, effect);
  return existing ? { row: existing, acquired: false } : null;
}

export function completeWorkflowEventEffect(
  runId: number,
  eventId: number,
  effect: string,
): WorkflowEventEffectRow | null {
  return db
    .query(
      `UPDATE workflow_event_effects
       SET status = 'completed', updated_at = ?
       WHERE run_id = ? AND event_id = ? AND effect = ?
       RETURNING *`,
    )
    .get(now(), runId, eventId, effect) as WorkflowEventEffectRow | null;
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
    currentStep?: string;
    reworkCount?: number;
    // string sets the human-wait reason, explicit null clears it (#1307).
    needsHumanReason?: string | null;
    activeStep?: string | null;
    activeSessionId?: string | null;
  },
): WorkflowRunRow | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const updatedAt = now();
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
  if (patch.activeStep !== undefined) {
    sets.push("active_step = ?");
    params.push(patch.activeStep);
  }
  if (patch.activeSessionId !== undefined) {
    sets.push("active_session_id = ?");
    params.push(patch.activeSessionId);
  }
  sets.push("updated_at = ?");
  params.push(updatedAt, id);
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
