// Settings > Workflows screen (/settings/workflows, #1006). Lists the instance's workflows and
// lets you create, edit, and archive them. A workflow is a global prompt bundle for the fixed
// Execute/Verify development loop (workflow design: workflow definitions); the two step prompts
// are the only user-configurable part. Same workflows/* RPCs the CLI uses; this is the
// management UI. Start-workflow and run status are intentionally out of scope here.

import { Check, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkflowInput } from "@/api/client";
import type { Workflow, WorkflowContracts } from "@/api/types";
import { SettingsLayout } from "@/components/settings-header";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button, disabledButtonStateClasses } from "@/components/ui/button";
import { errorMessage } from "@/lib/error-message";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import { cn } from "@/lib/utils";
import { useSettings, useUpdateSettings } from "@/queries/settings";
import {
  useArchiveWorkflow,
  useUpdateWorkflow,
  useWorkflowContracts,
  useWorkflows,
} from "@/queries/workflows";
import { workflowCreatePrompt } from "../../../core/workflow/workflow-create-prompt.ts";

// The fixed Workflow steps, in order, with the wire field each maps to. The form presents their
// textareas one at a time through tabs while keeping both values in form state.
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
  label: "Workflow orchestration",
};

type OpenContract = { contractKey: keyof WorkflowContracts; label: string };

const contractLinkClasses =
  "text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const dialogFocusableSelector =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

function trapDialogFocus(
  event: React.KeyboardEvent<HTMLElement>,
  dialog: HTMLElement,
) {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector),
  ).filter((element) => !element.closest("[hidden]"));
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function WorkflowsPage() {
  const { data: workflows, isLoading, isError } = useWorkflows();

  return (
    <div data-debug-component="WorkflowsPage">
      <SettingsLayout section="workflows">
        <WorkflowContractLanguageSettings />

        <section className="mt-8">
          <NewWorkflowButton />

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
      </SettingsLayout>
    </div>
  );
}

export function RepoWorkflowsSection({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const fullName = `${owner}/${repo}`;
  const {
    data: workflows,
    isLoading,
    isError,
  } = useWorkflows({
    repo: fullName,
  });
  return (
    <section className="mt-6">
      <NewWorkflowButton repo={fullName} />
      <div className="mt-6 flex flex-col gap-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-destructive">Failed to load workflows.</p>
        ) : !workflows || workflows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No repository workflows yet.
          </p>
        ) : (
          workflows.map((workflow) => (
            <WorkflowCard key={workflow.id} workflow={workflow} />
          ))
        )}
      </div>
    </section>
  );
}

// New workflow is AI-driven, mirroring New issue (#1889): instead of prefilling a create form, it
// launches a herdr agent seeded with the workflow-create instructions, and that agent runs
// `lh workflow create`. Global settings omit repo; repository settings pass one into the prompt so
// the generated command includes the explicit scope. The terminal service uses LoopHub home as cwd.
function launchSuffix(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

function NewWorkflowButton({ repo }: { repo?: string }) {
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
          repo,
          prompt: workflowCreatePrompt(
            settings?.workflowContractLanguage,
            repo,
          ),
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
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const archive = useArchiveWorkflow();

  return (
    <div data-debug-component="WorkflowCard" className="rounded-md border p-4">
      <div className="flex items-start justify-between gap-3">
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
            onClick={() => setConfirmingArchive(true)}
          >
            Archive
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

      {confirmingArchive ? (
        <ConfirmDialog
          title={`Archive "${workflow.name}"?`}
          body="This removes the workflow from workflow lists and start options. Existing workflow runs are preserved."
          confirmLabel="Archive"
          pending={archive.isPending}
          error={archive.error ? errorMessage(archive.error) : null}
          onConfirm={async () => {
            try {
              await archive.mutateAsync(workflow.id);
            } catch {
              return; // surfaced via archive.error above
            }
            setConfirmingArchive(false);
          }}
          onCancel={() => {
            archive.reset();
            setConfirmingArchive(false);
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropDismiss = useBackdropDismiss(onClose);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
      ?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-6"
      {...backdropDismiss}
    >
      <div
        ref={dialogRef}
        data-debug-component="WorkflowDialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex h-full w-full max-w-7xl flex-col rounded-lg border bg-background shadow-lg"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          trapDialogFocus(event, event.currentTarget);
        }}
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
        {children}
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
  const [activePrompt, setActivePrompt] =
    useState<(typeof STEP_FIELDS)[number]["key"]>("execute_prompt");
  const executeTabRef = useRef<HTMLButtonElement>(null);
  const verifyTabRef = useRef<HTMLButtonElement>(null);
  const tabRefs = {
    execute_prompt: executeTabRef,
    verify_prompt: verifyTabRef,
  };

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
        id: workflow.id,
        // new_name renames; unchanged name is a harmless no-op patch.
        patch: { ...rest, new_name: nextName },
      });
    } catch {
      return; // surfaced via mutation.error below
    }
    onDone();
  }

  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const activeIndex = STEP_FIELDS.findIndex(
      (step) => step.key === activePrompt,
    );
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") {
      nextIndex = (activeIndex - 1 + STEP_FIELDS.length) % STEP_FIELDS.length;
    } else if (event.key === "ArrowRight") {
      nextIndex = (activeIndex + 1) % STEP_FIELDS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = STEP_FIELDS.length - 1;
    }
    if (nextIndex === null) return;

    event.preventDefault();
    const nextPrompt = STEP_FIELDS[nextIndex].key;
    setActivePrompt(nextPrompt);
    tabRefs[nextPrompt].current?.focus();
  }

  return (
    <form
      data-debug-component="WorkflowForm"
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (!mutation.isPending) onSubmit();
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Name</span>
            <input
              type="text"
              className="rounded-md border bg-background px-3 py-1.5 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-dialog-initial-focus
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
        </div>

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
            Coordinates the Execute and Verify steps. This fixed system prompt
            is not editable.
          </p>
        </div>

        <div className="flex min-h-[28rem] flex-1 flex-col">
          <div
            role="tablist"
            aria-label="Workflow prompts"
            className="flex h-10 shrink-0 items-end gap-1 border-b"
          >
            {STEP_FIELDS.map((step) => {
              const active = step.key === activePrompt;
              return (
                <button
                  key={step.key}
                  ref={tabRefs[step.key]}
                  id={`workflow-edit-${workflow.id}-${step.key}-tab`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`workflow-edit-${workflow.id}-${step.key}-panel`}
                  tabIndex={active ? 0 : -1}
                  className={cn(
                    "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    active
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                  onClick={() => setActivePrompt(step.key)}
                  onKeyDown={onTabKeyDown}
                >
                  {step.label}
                </button>
              );
            })}
          </div>

          {STEP_FIELDS.map((step) => {
            const active = step.key === activePrompt;
            return (
              <div
                key={step.key}
                id={`workflow-edit-${workflow.id}-${step.key}-panel`}
                role="tabpanel"
                aria-labelledby={`workflow-edit-${workflow.id}-${step.key}-tab`}
                hidden={!active}
                className={cn(
                  "min-h-0 flex-1 flex-col gap-2 pt-3",
                  active ? "flex" : "hidden",
                )}
              >
                <div className="flex justify-end text-sm">
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
                  id={`workflow-edit-${workflow.id}-${step.key}`}
                  aria-labelledby={`workflow-edit-${workflow.id}-${step.key}-tab`}
                  className="min-h-80 flex-1 resize-y rounded-md border bg-background px-3 py-2 font-mono text-sm leading-relaxed"
                  value={prompts[step.key]}
                  onChange={(e) =>
                    setPrompts((prev) => ({
                      ...prev,
                      [step.key]: e.target.value,
                    }))
                  }
                />
              </div>
            );
          })}
        </div>
      </div>

      {openContract ? (
        <SystemPromptDialog
          contractLabel={openContract.label}
          content={contracts.data?.[openContract.contractKey]}
          loading={contracts.isLoading}
          error={contracts.isError}
          onClose={() => setOpenContract(null)}
        />
      ) : null}

      <div className="flex shrink-0 items-center justify-between gap-4 border-t px-5 py-4">
        {mutation.error ? (
          <p className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save changes"}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropDismiss = useBackdropDismiss(onClose);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
      ?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-4"
      {...backdropDismiss}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        ref={dialogRef}
        data-debug-component="SystemPromptDialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex w-full max-w-4xl flex-col rounded-lg border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => trapDialogFocus(event, event.currentTarget)}
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
            data-dialog-initial-focus
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
  const backdropDismiss = useBackdropDismiss(() => {
    if (!pending) onCancel();
  });

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
      {...backdropDismiss}
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
