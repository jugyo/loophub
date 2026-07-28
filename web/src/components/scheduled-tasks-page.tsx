// Scheduled tasks screen (/r/:owner/:repo/scheduled-tasks, #880). Lists a repo's scheduled tasks
// and lets you launch the create flow, edit / delete existing tasks, and Run now. A task is a saved
// prompt an agent (Claude Code / Codex) runs at one or more times of day; the worker fires each
// registered time once per day. Same RPCs/hooks as the CLI would use (scheduledTasks/*); this is the
// management UI.

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { CodingAgent, ScheduledTask } from "@/api/types";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button } from "@/components/ui/button";
import { CODING_AGENT_LABELS } from "@/lib/agent-models";
import {
  useDeleteScheduledTask,
  useRunScheduledTask,
  useScheduledTask,
  useScheduledTasks,
  useUpdateScheduledTask,
} from "@/queries/scheduled-tasks";
import { useSettings } from "@/queries/settings";
import { scheduledTaskCreatePrompt } from "../../../core/workflow/scheduled-task-create-prompt.ts";

// Parse a free-text times field ("09:00, 18:00" / newline / space separated) into a string array.
// Validation of the HH:MM shape happens server-side; this only splits.
function parseTimes(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function launchSuffix(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

export function ScheduledTasksPage({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const { data: tasks, isLoading, isError } = useScheduledTasks(owner, repo);

  return (
    <div
      data-debug-component="ScheduledTasksPage"
      className="mx-auto max-w-content"
    >
      <p className="text-sm text-muted-foreground">
        A scheduled task runs a saved prompt with the chosen agent at one or
        more times of day. Each registered time fires once per day; use Run now
        to fire immediately.
      </p>

      <div className="mt-4">
        <CreateScheduledTaskButton owner={owner} repo={repo} />
      </div>

      <div className="mt-6 flex flex-col gap-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-destructive">Failed to load tasks.</p>
        ) : !tasks || tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No scheduled tasks yet.
          </p>
        ) : (
          tasks.map((task) => (
            <TaskCard key={task.id} owner={owner} repo={repo} task={task} />
          ))
        )}
      </div>
    </div>
  );
}

function CreateScheduledTaskButton({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const { launchTerminal } = useTerminalLauncher();
  const { data: settings } = useSettings();
  const fullRepo = `${owner}/${repo}`;

  return (
    <Button
      aria-label="New scheduled task"
      title="New scheduled task"
      onClick={() =>
        launchTerminal({
          repo: fullRepo,
          label: `New scheduled task - ${launchSuffix()}`,
          workflow: "scheduled-task-create",
          prompt: scheduledTaskCreatePrompt(settings?.workflowContractLanguage),
        })
      }
    >
      <Plus className="size-4" />
      New scheduled task
    </Button>
  );
}

function TaskCard({
  owner,
  repo,
  task,
}: {
  owner: string;
  repo: string;
  task: ScheduledTask;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const del = useDeleteScheduledTask(owner, repo);
  const run = useRunScheduledTask(owner, repo);

  if (editing) {
    return (
      <div data-debug-component="TaskCard" className="rounded-md border p-4">
        <TaskForm
          owner={owner}
          repo={repo}
          task={task}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div data-debug-component="TaskCard" className="rounded-md border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium">{task.title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {CODING_AGENT_LABELS[task.agent as CodingAgent] ?? task.agent} ·{" "}
            {task.times.length > 0 ? task.times.join(", ") : "no times"} ·{" "}
            {task.model ?? `${task.default_model} (default)`}
            {task.agent === "codex"
              ? ` · effort ${task.effort ?? `${task.default_effort} (default)`}`
              : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={run.isPending}
            onClick={() => run.mutate(task.id)}
          >
            {run.isPending ? "Running…" : "Run now"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
        {task.prompt}
      </p>

      {run.error ? (
        <p className="mt-2 text-sm text-destructive">{String(run.error)}</p>
      ) : run.data && run.data.status === "failure" ? (
        // The RPC resolves even when the herdr launch failed (the run row records the failure), so
        // surface it here instead of leaving Run now looking successful.
        <p className="mt-2 text-sm text-destructive">
          Run failed to launch{run.data.error ? `: ${run.data.error}` : ""}.
        </p>
      ) : null}

      <button
        type="button"
        className="mt-3 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Hide run log" : "Show run log"}
      </button>
      {expanded ? <RunLog owner={owner} repo={repo} id={task.id} /> : null}

      {confirmingDelete ? (
        <ConfirmDialog
          title={`Delete "${task.title}"?`}
          body="This removes the scheduled task and its run log. This cannot be undone."
          confirmLabel="Delete"
          pending={del.isPending}
          error={del.error ? String(del.error) : null}
          onConfirm={async () => {
            try {
              await del.mutateAsync(task.id);
            } catch {
              return;
            }
            setConfirmingDelete(false);
          }}
          onCancel={() => setConfirmingDelete(false)}
        />
      ) : null}
    </div>
  );
}

// The task's recent run log, fetched only when expanded (keeps the list query lean).
function RunLog({
  owner,
  repo,
  id,
}: {
  owner: string;
  repo: string;
  id: number;
}) {
  const { data, isLoading, isError } = useScheduledTask(owner, repo, id);

  if (isLoading)
    return <p className="mt-2 text-xs text-muted-foreground">Loading…</p>;
  if (isError)
    return (
      <p className="mt-2 text-xs text-destructive">Failed to load runs.</p>
    );
  const runs = data?.runs ?? [];
  if (runs.length === 0)
    return <p className="mt-2 text-xs text-muted-foreground">No runs yet.</p>;

  return (
    <ul
      data-debug-component="RunLog"
      className="mt-2 flex flex-col gap-1 text-xs"
    >
      {runs.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2">
          <span
            className={
              r.status === "failure"
                ? "text-destructive"
                : r.status === "success"
                  ? "text-foreground"
                  : "text-muted-foreground"
            }
          >
            {r.status}
          </span>
          <span className="text-muted-foreground">
            {r.trigger === "manual" ? "manual" : (r.scheduled_time ?? "")} ·{" "}
            {r.started_at}
          </span>
          {r.error ? (
            <span className="text-destructive">— {r.error}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// Shared edit form for existing tasks. New tasks are created through a Herdr session.
function TaskForm({
  owner,
  repo,
  task,
  onDone,
  onCancel,
}: {
  owner: string;
  repo: string;
  task: ScheduledTask;
  onDone: () => void;
  onCancel: () => void;
}) {
  const update = useUpdateScheduledTask(owner, repo);

  const [title, setTitle] = useState(task.title);
  const [prompt, setPrompt] = useState(task.prompt);
  const [agent, setAgent] = useState<CodingAgent>(task.agent as CodingAgent);
  const [times, setTimes] = useState(task.times.join(", "));
  const [model, setModel] = useState(task.model ?? "");
  const [effort, setEffort] = useState(task.effort ?? "");

  const mutation = update;

  async function onSubmit() {
    const input = {
      title: title.trim(),
      prompt: prompt.trim(),
      agent,
      times: parseTimes(times),
      model: model.trim() || null,
      effort: effort.trim() || null,
    };
    try {
      await update.mutateAsync({ id: task.id, patch: input });
    } catch {
      return; // surfaced via mutation.error
    }
    onDone();
  }

  return (
    <form
      data-debug-component="TaskForm"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mutation.isPending) onSubmit();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Title</span>
        <input
          type="text"
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Prompt</span>
        <textarea
          className="min-h-24 rounded-md border bg-background px-3 py-1.5 text-sm"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Agent</span>
        <select
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
          value={agent}
          onChange={(e) => setAgent(e.target.value as CodingAgent)}
        >
          <option value="claude-code">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Times</span>
        <input
          type="text"
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
          placeholder="09:00, 18:00"
          value={times}
          onChange={(e) => setTimes(e.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          24-hour HH:MM, comma or space separated. Each time fires once per day.
        </span>
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Model</span>
          <input
            type="text"
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
            placeholder={
              task.default_model
                ? `${task.default_model} (default)`
                : "agent default"
            }
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">Effort</span>
          <input
            type="text"
            className="rounded-md border bg-background px-3 py-1.5 text-sm"
            placeholder={`${task.default_effort} (default)`}
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">
            Codex only; Claude Code ignores effort.
          </span>
        </label>
      </div>

      {mutation.error ? (
        <p className="text-sm text-destructive">{String(mutation.error)}</p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[6vh]"
      onClick={onCancel}
    >
      <div
        data-debug-component="ConfirmDialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex w-full max-w-md flex-col rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-3 text-sm text-muted-foreground">{body}</p>
        {error ? (
          <p className="mt-3 text-sm text-destructive">{error}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
