// lh-worker runtime: tail the shared `events` table and run the repo's `.loophub/workflow.yml`
// commands for matched events. This is the process layer (like web/server) — the pure pieces
// (parse/match/env/cursor) live in core/ and carry the test coverage. See issue #52.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logsDir, workerCursorPath } from "../core/config.ts";
import { worktreeList } from "../core/git.ts";
import {
  events,
  pulls,
  type Repo,
  repos,
  subscriptions,
  terminal,
} from "../core/service.ts";
import { resolveStartCursor, writeCursor } from "../core/worker-cursor.ts";
import {
  buildRunEnv,
  loadWorkflow,
  matchWorktreePath,
  SUPPORTED_EVENTS,
  stepsFor,
  type WorkflowStep,
} from "../core/workflow.ts";
import { workerLog } from "./logger.ts";

const DEFAULT_POLL_MS = 1000;
const PAGE = 100;
const ACTOR = "lh-worker";

const isSupported = (type: string) =>
  (SUPPORTED_EVENTS as readonly string[]).includes(type);

// repo owner/name come from the `--name owner/repo` flag and are not validated for path
// components; neutralize separators / `..` before using them as log-dir segments so output
// can never escape $LOOPHUB_HOME/logs (defense in depth — same user, but cheap to guard).
const safeSegment = (s: string) =>
  s.replace(/[/\\]/g, "_").replace(/\.\./g, "_") || "_";

interface EventRow {
  id: number;
  repo_id: number | null;
  type: string;
  actor: string;
  payload: string;
  created_at: string;
}

function parsePayload(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    return {};
  }
}

interface RunResult {
  exitCode: number | null;
  durationMs: number;
}

function workflowContextFields(input: {
  repo: Repo;
  row: EventRow;
  issueNumber?: number;
  prNumber?: number;
}): string {
  return [
    `repo=${input.repo.full_name}`,
    `event_id=${input.row.id}`,
    `event_type=${input.row.type}`,
    `issue=${input.issueNumber ?? "-"}`,
    `pr=${input.prNumber ?? "-"}`,
  ].join(" ");
}

function logWorkflowStepStarted(context: string, stepIndex: number) {
  workerLog.info(
    `lh-worker: workflow step started ${context} task=workflow-step-${stepIndex}`,
  );
}

function logWorkflowStepCompleted(
  context: string,
  stepIndex: number,
  result: RunResult,
) {
  const status = result.exitCode === 0 ? "completed" : "failed";
  workerLog.info(
    `lh-worker: workflow step ${status} ${context} task=workflow-step-${stepIndex} exit_code=${result.exitCode ?? "null"} duration_ms=${result.durationMs}`,
  );
}

// Spawn one `run` step via `sh -c`, capturing stdout+stderr to the event's log file. Never
// throws: a spawn failure resolves with exitCode 127 so the caller keeps going.
function runStep(
  step: WorkflowStep,
  cwd: string,
  env: Record<string, string>,
  logFile: string,
): Promise<RunResult> {
  const startedAt = Date.now();
  appendFileSync(logFile, `\n$ ${step.run}\n`);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("sh", ["-c", step.run], {
        cwd,
        env: { ...process.env, ...env },
      });
    } catch (e) {
      appendFileSync(
        logFile,
        `lh-worker: failed to spawn: ${e instanceof Error ? e.message : e}\n`,
      );
      resolve({ exitCode: 127, durationMs: Date.now() - startedAt });
      return;
    }
    const append = (chunk: Buffer) => appendFileSync(logFile, chunk);
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      appendFileSync(logFile, `lh-worker: ${e.message}\n`);
      resolve({ exitCode: 127, durationMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code, durationMs: Date.now() - startedAt });
    });
  });
}

// Resolve the worktree path for a PR head ref via on-disk `git worktree list` (not LoopHub's
// naming convention). Returns "" when the ref has no checked-out worktree.
async function prWorktreePath(repo: Repo, prNumber: number): Promise<string> {
  const headRef = pulls.headRefForNumber(repo.id, prNumber);
  if (!headRef) return "";
  const worktrees = await worktreeList(repo.local_path);
  return matchWorktreePath(headRef, worktrees);
}

// Run every configured step for one matched event. Each step runs even if a prior one failed;
// per-step start/finish are recorded as `workflow.run_started` / `workflow.run_completed`
// events (visible on the Web timeline) and full output goes to the log file.
export async function dispatchEvent(row: EventRow): Promise<void> {
  if (row.repo_id == null) return;
  const repo = repos.getById(row.repo_id);
  if (!repo) return;

  const payload = parsePayload(row.payload);
  const number =
    typeof payload?.number === "number" ? payload.number : undefined;

  if (row.type === "issue.closed" && number !== undefined) {
    try {
      const result = await terminal.cleanupClosedIssueNewIssueAgent({
        repo: repo.full_name,
        issueNumber: number,
      });
      if (result.failed > 0) {
        console.error(
          `lh-worker: issue close herdr cleanup failed for ${repo.full_name}#${number}`,
        );
      }
    } catch (e) {
      console.error(
        `lh-worker: issue close herdr cleanup error (event ${row.id}):`,
        e,
      );
    }
  }

  // Generic pub/sub delivery (#1232): every event goes to its `lh subscribe` subscribers,
  // independent of the workflow.yml wiring below. Failures are logged, never retried — a
  // subscription whose pane is gone is removed on this first failed notify (lazy cleanup).
  try {
    const notify = await subscriptions.notifyForEvent(row);
    if (notify.notified > 0 || notify.removed > 0) {
      workerLog.info(
        `lh-worker: event subscriptions notified event_id=${row.id} type=${row.type} notified=${notify.notified} removed=${notify.removed}`,
      );
    }
    for (const failure of notify.failures) {
      workerLog.error(
        `lh-worker: event subscription notify failed (subscription removed) subscription_id=${failure.subscription_id} pane=${failure.herdr_session}/${failure.herdr_pane_id} error=${failure.error}`,
      );
    }
  } catch (e) {
    console.error(`lh-worker: subscription notify error (event ${row.id}):`, e);
  }

  if (!isSupported(row.type)) return;

  const workflow = loadWorkflow(repo.local_path);
  if (!workflow) return;
  const steps = stepsFor(workflow, row.type);
  if (steps.length === 0) return;

  const isPull = row.type.startsWith("pull_request.");
  const issueNumber = isPull ? undefined : number;
  const prNumber = isPull ? number : undefined;
  const worktreePath = isPull
    ? await prWorktreePath(repo, prNumber ?? -1)
    : undefined;

  const env = buildRunEnv({
    event: { type: row.type, actor: row.actor, payload },
    repoFullName: repo.full_name,
    issueNumber,
    prNumber,
    worktreePath,
  });

  const logFile = join(
    logsDir(),
    safeSegment(repo.owner),
    safeSegment(repo.name),
    `${row.type}-${row.id}.log`,
  );
  mkdirSync(dirname(logFile), { recursive: true });

  const context = workflowContextFields({
    repo,
    row,
    issueNumber,
    prNumber,
  });

  for (const [index, step] of steps.entries()) {
    const stepIndex = index + 1;
    logWorkflowStepStarted(context, stepIndex);
    events.emit(repo.id, "workflow.run_started", ACTOR, {
      number,
      source_event: row.id,
      command: step.run,
    });
    let result: RunResult;
    try {
      result = await runStep(step, repo.local_path, env, logFile);
    } catch (e) {
      // runStep is defensive, but never let one step abort the rest of the event.
      console.error(`lh-worker: step error (event ${row.id}):`, e);
      result = { exitCode: 1, durationMs: 0 };
    }
    logWorkflowStepCompleted(context, stepIndex, result);
    events.emit(repo.id, "workflow.run_completed", ACTOR, {
      number,
      source_event: row.id,
      command: step.run,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      log: logFile,
    });
  }
}

export interface WorkerHandle {
  stop: () => void;
}

// Poll the events table by id cursor and dispatch matched events. The cursor is persisted after
// every event so a restart resumes exactly where it left off.
export function startWorker(
  opts: { pollMs?: number; cursorPath?: string } = {},
): WorkerHandle {
  const pollMs =
    opts.pollMs != null && Number.isFinite(opts.pollMs) && opts.pollMs > 0
      ? opts.pollMs
      : DEFAULT_POLL_MS;
  const cursorPath = opts.cursorPath ?? workerCursorPath();
  let cursor = resolveStartCursor(cursorPath, events.newestId());
  let stopped = false;
  let running = false;
  workerLog.info(
    `lh-worker: event tail started poll_ms=${pollMs} cursor=${cursor} page_size=${PAGE}`,
  );

  const drain = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (;;) {
        if (stopped) break;
        const rows = events.page(cursor, null, PAGE) as EventRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
          if (stopped) break;
          try {
            await dispatchEvent(row);
          } catch (e) {
            // One failed event must not stall the tail.
            console.error(`lh-worker: error dispatching event ${row.id}:`, e);
          }
          cursor = Math.max(cursor, row.id);
          writeCursor(cursorPath, cursor);
        }
      }
    } finally {
      running = false;
    }
  };

  // Not unref'd: the poll timer is what keeps the standalone lh-worker process alive (unlike
  // lh-web, which is held open by its HTTP server). stop() clears it for embedded/test callers.
  const timer = setInterval(() => {
    drain().catch((e) => console.error("lh-worker: drain error:", e));
  }, pollMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
