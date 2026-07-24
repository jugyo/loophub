// Settings > Workflows screen (/settings/workflows, #1006). Lists the instance's workflows and
// lets you create, edit, and delete them. A workflow is a global prompt bundle for the fixed
// Execute/Verify development loop (workflow design: workflow definitions); the two step prompts
// are the only user-configurable part. Same workflows/* RPCs the CLI uses; this is the
// management UI. Start-workflow and run status are intentionally out of scope here.

import { useNavigate } from "@tanstack/react-router";
import { Check, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkflowInput } from "@/api/client";
import type { Workflow, WorkflowContracts } from "@/api/types";
import { SettingsHeader } from "@/components/settings-header";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button, disabledButtonStateClasses } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import { cn } from "@/lib/utils";
import { useSettings, useUpdateSettings } from "@/queries/settings";
import {
  useDeleteWorkflow,
  useUpdateWorkflow,
  useWorkflowContracts,
  useWorkflows,
} from "@/queries/workflows";
import { workflowCreatePrompt } from "../../../core/workflow/workflow-create-prompt.ts";

// The fixed Workflow steps, in order, with the wire field each maps to. Rendered as one textarea
// per step in the form.
const STEP_FIELDS: {
  key: "execute_prompt" | "verify_prompt";
  contractKey: keyof WorkflowContracts;
  label: string;
}[] = [
  { key: "execute_prompt", contractKey: "execute", label: "Execute prompt" },
  { key: "verify_prompt", contractKey: "verify", label: "Verify prompt" },
];

// The parent contract orchestrates the run around those steps (#1855). It has no configurable
// prompt, so the form shows it read-only through the same system prompt dialog.
const PARENT_CONTRACT: OpenContract = {
  contractKey: "parent",
  label: "Parent",
};

type OpenContract = { contractKey: keyof WorkflowContracts; label: string };

const contractLinkClasses =
  "text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function WorkflowsPage() {
  const navigate = useNavigate();
  const { data: workflows, isLoading, isError } = useWorkflows();

  return (
    <div data-debug-component="WorkflowsPage" className="mx-auto max-w-content">
      <SettingsHeader
        activeTab="workflows"
        onTabChange={(tab) => {
          if (tab === "agent") void navigate({ to: "/settings" });
        }}
        panelIds={{ workflows: "settings-workflow-management-panel" }}
      />

      <div
        id="settings-workflow-management-panel"
        role="tabpanel"
        aria-labelledby="settings-workflows-tab"
        className="mt-6"
      >
        <WorkflowContractLanguageSettings />

        <section className="mt-8">
          <h2 className="text-2xl font-semibold">Workflows</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Workflows are global prompt bundles for the fixed Execute/Verify
            development loop. Each step's prompt is the only configurable part;
            the step contracts are fixed.
          </p>

          <div className="mt-4">
            <NewWorkflowButton />
          </div>

          <div className="mt-6 flex flex-col gap-3">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : isError ? (
              <p className="text-sm text-destructive">
                Failed to load workflows.
              </p>
            ) : !workflows || workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No workflows yet.</p>
            ) : (
              workflows.map((workflow) => (
                <WorkflowCard key={workflow.id} workflow={workflow} />
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

// New workflow is AI-driven, mirroring New issue (#1889): instead of prefilling a create form, it
// launches a herdr agent seeded with the workflow-create instructions, and that agent runs
// `lh workflow create`. A workflow is global, so this launch carries no repo — the terminal service
// pins it to the LoopHub-home cwd.
function launchSuffix(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

function NewWorkflowButton() {
  const { launchTerminal } = useTerminalLauncher();
  const { data: settings } = useSettings();

  return (
    <Button
      aria-label="New workflow"
      title="New workflow"
      onClick={() =>
        launchTerminal({
          workflow: "workflow-create",
          label: `New workflow - ${launchSuffix()}`,
          prompt: workflowCreatePrompt(settings?.workflowContractLanguage),
        })
      }
    >
      <Plus className="size-4" />
      New workflow
    </Button>
  );
}

function WorkflowContractLanguageSettings() {
  const { data, isLoading } = useSettings();
  const update = useUpdateSettings();
  const language = data?.workflowContractLanguage ?? "en";

  return (
    <section
      data-debug-component="WorkflowContractLanguageSettings"
      className="max-w-md"
    >
      <h2 className="text-sm font-medium">Workflow contract language</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Language for LoopHub&apos;s fixed Parent, Execute, and Verify
        instructions. New runs keep the language selected when they start.
      </p>
      <div
        role="radiogroup"
        aria-label="Workflow contract language"
        className="mt-3 rounded-md border"
      >
        {[
          { value: "en" as const, label: "English" },
          { value: "ja" as const, label: "日本語" },
        ].map((option) => {
          const active = language === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={isLoading || update.isPending}
              className={cn(
                "flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground",
                disabledButtonStateClasses,
              )}
              onClick={() => {
                if (active) return;
                update.mutate({ workflowContractLanguage: option.value });
              }}
            >
              <Check
                className={`mt-0.5 size-4 shrink-0 ${active ? "" : "invisible"}`}
                aria-hidden="true"
              />
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const del = useDeleteWorkflow();

  return (
    <div data-debug-component="WorkflowCard" className="rounded-md border p-4">
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

      {editing ? (
        <WorkflowDialog
          title={`Edit "${workflow.name}"`}
          onClose={() => setEditing(false)}
        >
          <WorkflowForm
            workflow={workflow}
            onDone={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        </WorkflowDialog>
      ) : null}

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

function WorkflowDialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[6vh]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        data-debug-component="WorkflowDialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-lg border bg-background shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 border-b px-5 py-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

// Edit-only workflow form. New workflow creation is now AI-driven (NewWorkflowButton, #1889); this
// form loads an existing workflow and saves changes to it.
function WorkflowForm({
  workflow,
  onDone,
  onCancel,
}: {
  workflow: Workflow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const update = useUpdateWorkflow();
  const settings = useSettings();
  const contracts = useWorkflowContracts(
    settings.data?.workflowContractLanguage,
  );
  const mutation = update;
  const [openContract, setOpenContract] = useState<OpenContract | null>(null);

  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? "");
  const [prompts, setPrompts] = useState<
    Record<(typeof STEP_FIELDS)[number]["key"], string>
  >({
    execute_prompt: workflow.execute_prompt,
    verify_prompt: workflow.verify_prompt,
  });

  async function onSubmit() {
    const fields: WorkflowInput = {
      name: name.trim(),
      description,
      execute_prompt: prompts.execute_prompt,
      verify_prompt: prompts.verify_prompt,
    };
    try {
      const { name: nextName, ...rest } = fields;
      await update.mutateAsync({
        name: workflow.name,
        // new_name renames; unchanged name is a harmless no-op patch.
        patch: { ...rest, new_name: nextName },
      });
    } catch {
      return; // surfaced via mutation.error below
    }
    onDone();
  }

  return (
    <form
      data-debug-component="WorkflowForm"
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
          autoFocus
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

      <div className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">{PARENT_CONTRACT.label}</span>
          <button
            type="button"
            className={contractLinkClasses}
            onClick={() => setOpenContract(PARENT_CONTRACT)}
          >
            System prompt
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Orchestrates the run around the two steps. Fixed by LoopHub, with no
          prompt to configure.
        </p>
      </div>

      {STEP_FIELDS.map((step) => (
        <div key={step.key} className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <label
              className="font-medium"
              htmlFor={`workflow-edit-${step.key}`}
            >
              {step.label}
            </label>
            <button
              type="button"
              className={contractLinkClasses}
              onClick={() =>
                setOpenContract({
                  contractKey: step.contractKey,
                  label: step.label.replace(" prompt", ""),
                })
              }
            >
              System prompt
            </button>
          </div>
          <textarea
            id={`workflow-edit-${step.key}`}
            className="min-h-48 rounded-md border bg-background px-3 py-1.5 text-sm"
            value={prompts[step.key]}
            onChange={(e) =>
              setPrompts((prev) => ({ ...prev, [step.key]: e.target.value }))
            }
          />
        </div>
      ))}

      {openContract ? (
        <SystemPromptDialog
          contractLabel={openContract.label}
          content={contracts.data?.[openContract.contractKey]}
          loading={contracts.isLoading}
          error={contracts.isError}
          onClose={() => setOpenContract(null)}
        />
      ) : null}

      {mutation.error ? (
        <p className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
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

function SystemPromptDialog({
  contractLabel,
  content,
  loading,
  error,
  onClose,
}: {
  contractLabel: string;
  content?: string;
  loading: boolean;
  error: boolean;
  onClose: () => void;
}) {
  const title = `${contractLabel} system prompt`;
  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-4"
      onClick={onClose}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        data-debug-component="SystemPromptDialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex w-full max-w-4xl flex-col rounded-lg border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">
              Fixed by LoopHub and shown here for reference.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close system prompt"
            autoFocus
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive">
              Failed to load the system prompt.
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-4 font-mono text-xs leading-relaxed">
              {content ?? ""}
            </pre>
          )}
        </div>
      </div>
    </div>
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
