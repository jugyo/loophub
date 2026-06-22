// lh-worker runtime: tail the shared `events` table and run the repo's `.loophub/workflow.yml`
// commands for matched events. This is the process layer (like web/server) — the pure pieces
// (parse/match/env/cursor) live in core/ and carry the test coverage. See issue #52.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logsDir, workerCursorPath } from "../core/config.ts";
import { worktreeList } from "../core/git.ts";
import * as S from "../core/store.ts";
import {
  buildRunEnv,
  loadWorkflow,
  matchWorktreePath,
  stepsFor,
  SUPPORTED_EVENTS,
  type WorkflowStep,
} from "../core/workflow.ts";
import { resolveStartCursor, writeCursor } from "../core/worker-cursor.ts";

const DEFAULT_POLL_MS = 1000;
const PAGE = 100;
const ACTOR = "lh-worker";

const isSupported = (type: string) => (SUPPORTED_EVENTS as readonly string[]).includes(type);

// repo owner/name come from the `--name owner/repo` flag and are not validated for path
// components; neutralize separators / `..` before using them as log-dir segments so output
// can never escape $LOOPHUB_HOME/logs (defense in depth — same user, but cheap to guard).
const safeSegment = (s: string) => s.replace(/[/\\]/g, "_").replace(/\.\./g, "_") || "_";

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
    let child;
    try {
      child = spawn("sh", ["-c", step.run], { cwd, env: { ...process.env, ...env } });
    } catch (e) {
      appendFileSync(logFile, `lh-worker: failed to spawn: ${e instanceof Error ? e.message : e}\n`);
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
async function prWorktreePath(repo: S.Repo, prNumber: number): Promise<string> {
  const issue = S.getIssue(repo.id, prNumber);
  if (!issue) return "";
  const pull = S.getPull(issue.id);
  if (!pull?.head_ref) return "";
  const worktrees = await worktreeList(repo.local_path);
  return matchWorktreePath(pull.head_ref, worktrees);
}

// Run every configured step for one matched event. Each step runs even if a prior one failed;
// per-step start/finish are recorded as `workflow.run_started` / `workflow.run_completed`
// events (visible on the Web timeline) and full output goes to the log file.
export async function dispatchEvent(row: EventRow): Promise<void> {
  if (!isSupported(row.type) || row.repo_id == null) return;
  const repo = S.getRepoById(row.repo_id);
  if (!repo) return;

  const workflow = loadWorkflow(repo.local_path);
  if (!workflow) return;
  const steps = stepsFor(workflow, row.type);
  if (steps.length === 0) return;

  const payload = parsePayload(row.payload);
  const number = typeof payload?.number === "number" ? payload.number : undefined;
  const isPull = row.type.startsWith("pull_request.");
  const issueNumber = isPull ? undefined : number;
  const prNumber = isPull ? number : undefined;
  const worktreePath = isPull ? await prWorktreePath(repo, prNumber ?? -1) : undefined;

  const env = buildRunEnv({
    event: { type: row.type, actor: row.actor, payload },
    repoFullName: repo.full_name,
    issueNumber,
    prNumber,
    worktreePath,
  });

  const logFile = join(logsDir(), safeSegment(repo.owner), safeSegment(repo.name), `${row.type}-${row.id}.log`);
  mkdirSync(dirname(logFile), { recursive: true });

  for (const step of steps) {
    S.emitEvent(repo.id, "workflow.run_started", ACTOR, {
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
    S.emitEvent(repo.id, "workflow.run_completed", ACTOR, {
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

// Tail the events table by id cursor and dispatch matched events. Mirrors web/server's
// startEventTail polling, but instead of republishing it runs workflow commands. The cursor is
// persisted after every event so a restart resumes exactly where it left off.
export function startWorker(opts: { pollMs?: number; cursorPath?: string } = {}): WorkerHandle {
  const pollMs =
    opts.pollMs != null && Number.isFinite(opts.pollMs) && opts.pollMs > 0
      ? opts.pollMs
      : DEFAULT_POLL_MS;
  const cursorPath = opts.cursorPath ?? workerCursorPath();
  const newest = S.listEvents(0, null, 1, undefined, "desc");
  let cursor = resolveStartCursor(cursorPath, newest.length ? newest[0].id : 0);
  let stopped = false;
  let running = false;

  const drain = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (;;) {
        if (stopped) break;
        const rows = S.listEvents(cursor, null, PAGE) as EventRow[];
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
