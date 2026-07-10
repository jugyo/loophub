// Settings > Workflows screen (/settings/workflows, #1006). Lists the instance's workflows and
// lets you create, edit, and delete them. A workflow is a global prompt bundle for the fixed
// Plan/Execute/Verify/Reflect development loop (docs/workflow.ja.md §5); the four step prompts
// are the only user-configurable part. Same workflows/* RPCs the CLI uses; this is the
// management UI. Start-workflow and run status are intentionally out of scope here.

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkflowInput } from "@/api/client";
import type { Workflow } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  useCreateWorkflow,
  useDeleteWorkflow,
  useUpdateWorkflow,
  useWorkflows,
} from "@/queries/workflows";
// core/workflow/example-prompts.ts is a pure, node-free constant (single source of truth for the
// create-form prefill, per §5.3 — prefill from a constant, do not seed a DB row).
import { WORKFLOW_EXAMPLE_PROMPTS } from "../../../core/workflow/example-prompts.ts";

// ApiError extends Error, so String(err) prefixes the class name ("ApiError: <message>"). Render the
// bare server message (e.g. the 422 validation text, the 409 delete-refusal text) instead — matching
// the codebase's dominant error-display pattern (issue-list, pull-list, ...).
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The four fixed Workflow steps, in order, with the wire field each maps to. Rendered as one textarea
// per step in the form.
const STEP_FIELDS: {
  key: "plan_prompt" | "execute_prompt" | "verify_prompt" | "reflect_prompt";
  label: string;
}[] = [
  { key: "plan_prompt", label: "Plan prompt" },
  { key: "execute_prompt", label: "Execute prompt" },
  { key: "verify_prompt", label: "Verify prompt" },
  { key: "reflect_prompt", label: "Reflect prompt" },
];

export function WorkflowsPage() {
  const { data: workflows, isLoading, isError } = useWorkflows();
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-content">
      <h1 className="text-2xl font-semibold">Workflows</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Workflows are global prompt bundles for the fixed
        Plan/Execute/Verify/Reflect development loop. Each step's prompt is the
        only configurable part; the step contracts are fixed.
      </p>

      <div className="mt-4">
        {creating ? null : (
          <Button
            aria-label="New workflow"
            title="New workflow"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-4" />
            New workflow
          </Button>
        )}
      </div>

      {creating ? (
        <div className="mt-4 rounded-md border p-4">
          <h2 className="mb-3 font-medium">New workflow</h2>
          <WorkflowForm
            mode="create"
            onDone={() => setCreating(false)}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-destructive">Failed to load workflows.</p>
        ) : !workflows || workflows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No workflows yet.</p>
        ) : (
          workflows.map((workflow) => (
            <WorkflowCard key={workflow.id} workflow={workflow} />
          ))
        )}
      </div>
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const del = useDeleteWorkflow();

  if (editing) {
    return (
      <div className="rounded-md border p-4">
        <WorkflowForm
          mode="edit"
          workflow={workflow}
          onDone={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium">{workflow.name}</h2>
          {workflow.description ? (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {workflow.description}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
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

      {confirmingDelete ? (
        <ConfirmDialog
          title={`Delete "${workflow.name}"?`}
          body="This removes the workflow. This cannot be undone."
          confirmLabel="Delete"
          pending={del.isPending}
          // A delete refused because an active workflow run still references the workflow comes back as
          // a 409; its message ("workflow is referenced by an active workflow run") is surfaced here so
          // the refusal is visible instead of a silent no-op.
          error={del.error ? errorMessage(del.error) : null}
          onConfirm={async () => {
            try {
              await del.mutateAsync(workflow.name);
            } catch {
              return; // surfaced via del.error above
            }
            setConfirmingDelete(false);
          }}
          onCancel={() => {
            del.reset();
            setConfirmingDelete(false);
          }}
        />
      ) : null}
    </div>
  );
}

// Shared create/edit form. In create mode the fields prefill from the example-prompts constant; in
// edit mode they load from the existing workflow.
function WorkflowForm({
  mode,
  workflow,
  onDone,
  onCancel,
}: {
  mode: "create" | "edit";
  workflow?: Workflow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const create = useCreateWorkflow();
  const update = useUpdateWorkflow();
  const mutation = mode === "create" ? create : update;

  const [name, setName] = useState(
    mode === "edit" ? (workflow?.name ?? "") : "",
  );
  const [description, setDescription] = useState(
    mode === "edit"
      ? (workflow?.description ?? "")
      : WORKFLOW_EXAMPLE_PROMPTS.description,
  );
  const [prompts, setPrompts] = useState<
    Record<(typeof STEP_FIELDS)[number]["key"], string>
  >(() => {
    if (mode === "edit" && workflow) {
      return {
        plan_prompt: workflow.plan_prompt,
        execute_prompt: workflow.execute_prompt,
        verify_prompt: workflow.verify_prompt,
        reflect_prompt: workflow.reflect_prompt,
      };
    }
    return {
      plan_prompt: WORKFLOW_EXAMPLE_PROMPTS.plan_prompt,
      execute_prompt: WORKFLOW_EXAMPLE_PROMPTS.execute_prompt,
      verify_prompt: WORKFLOW_EXAMPLE_PROMPTS.verify_prompt,
      reflect_prompt: WORKFLOW_EXAMPLE_PROMPTS.reflect_prompt,
    };
  });

  async function onSubmit() {
    const fields: WorkflowInput = {
      name: name.trim(),
      description,
      plan_prompt: prompts.plan_prompt,
      execute_prompt: prompts.execute_prompt,
      verify_prompt: prompts.verify_prompt,
      reflect_prompt: prompts.reflect_prompt,
    };
    try {
      if (mode === "create") {
        await create.mutateAsync(fields);
      } else if (workflow) {
        const { name: nextName, ...rest } = fields;
        await update.mutateAsync({
          name: workflow.name,
          // new_name renames; unchanged name is a harmless no-op patch.
          patch: { ...rest, new_name: nextName },
        });
      }
    } catch {
      return; // surfaced via mutation.error below
    }
    onDone();
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mutation.isPending) onSubmit();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Name</span>
        <input
          type="text"
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Description</span>
        <input
          type="text"
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      {STEP_FIELDS.map((step) => (
        <label key={step.key} className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{step.label}</span>
          <textarea
            className="min-h-24 rounded-md border bg-background px-3 py-1.5 text-sm"
            value={prompts[step.key]}
            onChange={(e) =>
              setPrompts((prev) => ({ ...prev, [step.key]: e.target.value }))
            }
          />
        </label>
      ))}

      {mutation.error ? (
        <p className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? "Saving…"
            : mode === "create"
              ? "Create workflow"
              : "Save changes"}
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
      // Ignore Escape while a request is in flight, so all dismissal paths honor the same pending
      // guard as the buttons (avoids resetting an in-flight delete mid-request).
      if (e.key === "Escape" && !pending) onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, pending]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[6vh]"
      onClick={() => {
        if (!pending) onCancel();
      }}
    >
      <div
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
