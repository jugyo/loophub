import { runHerdrLaunch, runHerdrLaunchCapture } from "./herdr-runner.ts";
import {
  actorFor,
  agentEffort,
  agentModel,
  buildHerdrLaunchPlan,
  buildScheduledTaskCommand,
  type CodingAgent,
  ensureWritable,
  herdrPaneCloseArgv,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrTabFocusArgv,
  isServiceError,
  parseHerdrAgentPaneId,
  parseHerdrRootPaneId,
  parseHerdrTabId,
  repoOr404,
  S,
  ServiceError,
  scheduledTaskJSON,
  scheduledTaskRunJSON,
  type TerminalLaunchRepo,
} from "./shared.ts";

// ===== scheduled tasks (#880) =====
//
// A repo-scoped saved prompt a coding agent (claude-code / codex) runs automatically at one or more
// times of day. CRUD lives here; firing (launching a herdr tab that runs the prompt non-interactively)
// is shared by `run` (Run now) and `sweep` (the worker's per-tick due check) via fireScheduledTask.
// The agent's output body is NOT persisted — only run metadata (start/end/status + herdr tab/pane
// refs) lands in scheduled_task_runs; the live output stays on the herdr side.

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// How long after a registered time the sweep will still fire it (minutes). A time fires only within
// this window after it comes due, so the sweep never retroactively fires a time that was already in
// the past when the task/time was created or when the worker started — which would otherwise let a
// task added in the afternoon with a morning time fire immediately, or make the worker's first tick
// of the day fire every already-passed time at once ("catch-up storm"). The window must exceed the
// sweep interval (worker DEFAULT_SCHEDULED_TASK_SWEEP_MS, 30s) so a due minute is never skipped
// between ticks; it also tolerates a brief worker restart across the scheduled minute. A time missed
// for longer than this (worker down through the whole window) is skipped for that day, like cron.
const FIRE_GRACE_MINUTES = 10;

// Validate + dedupe + sort a list of "HH:MM" 24h local-time strings. Empty is allowed (a task with
// no times never auto-fires but can still be launched via Run now).
function normalizeTimes(times: unknown): string[] {
  if (!Array.isArray(times))
    throw new ServiceError(422, "times must be an array of HH:MM strings");
  const out = new Set<string>();
  for (const t of times) {
    if (typeof t !== "string" || !TIME_RE.test(t))
      throw new ServiceError(
        422,
        `invalid time ${JSON.stringify(t)} (expected 24-hour HH:MM)`,
      );
    out.add(t);
  }
  return [...out].sort();
}

function normalizeAgent(agent: unknown): CodingAgent {
  if (agent === "claude-code" || agent === "codex") return agent;
  throw new ServiceError(422, "agent must be 'claude-code' or 'codex'");
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new ServiceError(422, `${field} is required`);
  return value.trim();
}

// null when the caller passed nothing/blank (=> resolve from the per-agent application default at
// fire time), else the trimmed override.
function optionalTrim(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string")
    throw new ServiceError(422, "model/effort must be strings");
  const t = value.trim();
  return t ? t : null;
}

// Local wall-clock parts used for due detection. The worker and the tasks share one host, so times
// are compared against the host's local time (not UTC). `date` (YYYY-MM-DD) + a due time form the
// per-day fire_key, so each registered time fires at most once per calendar day.
function localNowParts(d: Date): { date: string; minutes: number } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { date, minutes: d.getHours() * 60 + d.getMinutes() };
}

function timeToMinutes(t: string): number | null {
  const m = TIME_RE.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Fire one task once: create a run row, launch a herdr tab running the prompt, and finalize the run
// with the launch outcome + tab/pane refs. Returns the run wire, or null when the fire was skipped
// (a scheduled slot already claimed by a concurrent tick — the UNIQUE(task_id, fire_key) collision).
async function fireScheduledTask(
  task: S.ScheduledTaskRow,
  opts: {
    trigger: "scheduled" | "manual";
    scheduledTime: string | null;
    fireKey: string | null;
  },
) {
  const repo = S.getRepoById(task.repo_id);
  if (!repo) throw new ServiceError(404, "Repository not found");

  let run: S.ScheduledTaskRunRow;
  try {
    run = S.createScheduledTaskRun({
      taskId: task.id,
      repoId: task.repo_id,
      trigger: opts.trigger,
      scheduledTime: opts.scheduledTime,
      fireKey: opts.fireKey,
    });
  } catch {
    // UNIQUE(task_id, fire_key) collision: another sweep tick already claimed this day's slot for
    // this time. That is the once-per-day guard doing its job — skip silently.
    return null;
  }

  const tlRepo: TerminalLaunchRepo = {
    full_name: repo.full_name,
    local_path: repo.local_path,
  };
  const agent = task.agent as CodingAgent;
  const command = buildScheduledTaskCommand({
    agent,
    prompt: task.prompt,
    model: task.model?.trim() || agentModel(agent),
    effort: task.effort?.trim() || agentEffort(agent),
  });

  let tabId: string | null = null;
  try {
    // Open a fresh tab so the agent starts in its own tab rather than splitting the focused pane
    // (#489). Best-effort: on any failure fall back to herdr's default split placement.
    let rootPaneId: string | null = null;
    try {
      const argv = herdrTabCreateArgv(tlRepo);
      const out = await runHerdrLaunchCapture(
        argv[0],
        argv.slice(1),
        repo.local_path,
      );
      tabId = parseHerdrTabId(out);
      rootPaneId = parseHerdrRootPaneId(out);
    } catch {
      tabId = null;
      rootPaneId = null;
    }

    const plan = buildHerdrLaunchPlan({
      repo: tlRepo,
      command,
      label: task.title,
      tabId,
    });
    const agentOut = await runHerdrLaunchCapture(
      plan.argv[0],
      plan.argv.slice(1),
      plan.cwd,
    );
    const paneId = parseHerdrAgentPaneId(agentOut);

    // Bring the new tab to the front and close the tab's leftover empty root pane — both
    // fire-and-forget, the agent is already running.
    if (tabId) {
      const focus = herdrTabFocusArgv(tlRepo, tabId);
      runHerdrLaunch(focus[0], focus.slice(1), repo.local_path).catch(() => {});
    }
    if (tabId && rootPaneId) {
      const close = herdrPaneCloseArgv(tlRepo, rootPaneId);
      runHerdrLaunch(close[0], close.slice(1), repo.local_path).catch(() => {});
    }

    return scheduledTaskRunJSON(
      S.finishScheduledTaskRun(run.id, {
        status: "success",
        herdrTabId: tabId,
        herdrPaneId: paneId,
      })!,
    );
  } catch (e) {
    // The agent failed to start. Don't leave the just-created empty tab behind.
    if (tabId) {
      const cleanup = herdrTabCloseArgv(tlRepo, tabId);
      runHerdrLaunch(cleanup[0], cleanup.slice(1), repo.local_path).catch(
        () => {},
      );
    }
    return scheduledTaskRunJSON(
      S.finishScheduledTaskRun(run.id, {
        status: "failure",
        error: isServiceError(e) ? e.message : "herdr launch failed",
      })!,
    );
  }
}

export const scheduledTasks = {
  list(repoName: string) {
    const r = repoOr404(repoName);
    return S.listScheduledTasks(r.id).map(scheduledTaskJSON);
  },

  get(repoName: string, id: number) {
    const r = repoOr404(repoName);
    const task = S.getScheduledTaskById(id);
    if (!task || task.repo_id !== r.id)
      throw new ServiceError(404, "Not Found");
    return {
      ...scheduledTaskJSON(task),
      runs: S.listScheduledTaskRuns(task.id).map(scheduledTaskRunJSON),
    };
  },

  create(
    repoName: string,
    input: {
      title: string;
      prompt: string;
      agent: string;
      times: string[];
      model?: string | null;
      effort?: string | null;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(repoName);
    ensureWritable(r);
    const row = S.createScheduledTask({
      repoId: r.id,
      title: requireNonEmpty(input.title, "title"),
      prompt: requireNonEmpty(input.prompt, "prompt"),
      agent: normalizeAgent(input.agent),
      timesJson: JSON.stringify(normalizeTimes(input.times)),
      model: optionalTrim(input.model),
      effort: optionalTrim(input.effort),
    });
    S.emitEvent(r.id, "scheduled_task.created", actorFor(sessionId), {
      id: row.id,
      title: row.title,
    });
    return scheduledTaskJSON(row);
  },

  update(
    repoName: string,
    id: number,
    patch: {
      title?: string;
      prompt?: string;
      agent?: string;
      times?: string[];
      model?: string | null;
      effort?: string | null;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(repoName);
    ensureWritable(r);
    const existing = S.getScheduledTaskById(id);
    if (!existing || existing.repo_id !== r.id)
      throw new ServiceError(404, "Not Found");
    const updated = S.updateScheduledTask(id, {
      title:
        patch.title !== undefined
          ? requireNonEmpty(patch.title, "title")
          : undefined,
      prompt:
        patch.prompt !== undefined
          ? requireNonEmpty(patch.prompt, "prompt")
          : undefined,
      agent:
        patch.agent !== undefined ? normalizeAgent(patch.agent) : undefined,
      timesJson:
        patch.times !== undefined
          ? JSON.stringify(normalizeTimes(patch.times))
          : undefined,
      model: patch.model !== undefined ? optionalTrim(patch.model) : undefined,
      effort:
        patch.effort !== undefined ? optionalTrim(patch.effort) : undefined,
    });
    S.emitEvent(r.id, "scheduled_task.updated", actorFor(sessionId), { id });
    return scheduledTaskJSON(updated!);
  },

  delete(repoName: string, id: number, sessionId?: string | null) {
    const r = repoOr404(repoName);
    const existing = S.getScheduledTaskById(id);
    if (!existing || existing.repo_id !== r.id)
      throw new ServiceError(404, "Not Found");
    S.deleteScheduledTask(id);
    S.emitEvent(r.id, "scheduled_task.deleted", actorFor(sessionId), { id });
    return { ok: true };
  },

  // Run now: fire immediately, without waiting for a registered time (trigger 'manual', no fire_key
  // so it is never blocked by the once-per-day guard).
  async run(repoName: string, id: number) {
    const r = repoOr404(repoName);
    ensureWritable(r);
    const task = S.getScheduledTaskById(id);
    if (!task || task.repo_id !== r.id)
      throw new ServiceError(404, "Not Found");
    const run = await fireScheduledTask(task, {
      trigger: "manual",
      scheduledTime: null,
      fireKey: null,
    });
    return run;
  },

  // Worker sweep: one tick. For every task, fire any registered time that has come due today and has
  // not fired yet. `now` is injectable for tests. Runs fires sequentially so a burst of due tasks
  // doesn't spawn many herdr launches at once; each fire's own errors are recorded on its run row.
  async sweep(now: Date = new Date()) {
    const { date, minutes: nowMinutes } = localNowParts(now);
    let fired = 0;
    for (const task of S.listAllScheduledTasks()) {
      // Skip archived repos, mirroring the `run` path (ensureWritable). Archiving a repo stops its
      // manual runs, so it must stop the automatic ones too.
      const repo = S.getRepoById(task.repo_id);
      if (!repo || S.isArchived(repo)) continue;
      let times: string[];
      try {
        times = JSON.parse(task.times_json);
      } catch {
        continue;
      }
      if (!Array.isArray(times)) continue;
      for (const t of times) {
        const minutes = timeToMinutes(t);
        // Fire only within the grace window after the time comes due (see FIRE_GRACE_MINUTES): not
        // yet due, or already past the window, is skipped.
        if (
          minutes == null ||
          minutes > nowMinutes ||
          nowMinutes - minutes > FIRE_GRACE_MINUTES
        )
          continue;
        const fireKey = `${date}T${t}`;
        if (S.scheduledRunExists(task.id, fireKey)) continue; // already fired this slot today
        try {
          const run = await fireScheduledTask(task, {
            trigger: "scheduled",
            scheduledTime: t,
            fireKey,
          });
          if (run) fired++;
        } catch (e) {
          console.error(
            `scheduled task ${task.id} fire failed:`,
            isServiceError(e) ? e.message : e,
          );
        }
      }
    }
    return { fired };
  },
};
