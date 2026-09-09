import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CodingAgent } from "@/api/types";
import {
  type AgentSettingValues,
  CodingAgentSettingsList,
} from "@/components/coding-agent-settings";
import { Button } from "@/components/ui/button";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";

export type WorkflowRole = "parent" | "execute" | "verify";
export type WorkflowRoleConfig = {
  runtime: CodingAgent;
  model: string;
  effort: string;
};

const ROLES: WorkflowRole[] = ["parent", "execute", "verify"];

export function CustomWorkflowDialog({
  workflows,
  initial,
  onClose,
  onStart,
}: {
  workflows: Array<{ id: number; name: string }>;
  initial: WorkflowRoleConfig;
  onClose: () => void;
  onStart: (
    workflowId: number,
    agents: Record<WorkflowRole, WorkflowRoleConfig>,
  ) => void;
}) {
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id ?? 0);
  const [agents, setAgents] = useState<
    Record<WorkflowRole, WorkflowRoleConfig>
  >({ parent: initial, execute: initial, verify: initial });
  const backdropDismiss = useBackdropDismiss(onClose);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function update(role: WorkflowRole, patch: Partial<WorkflowRoleConfig>) {
    setAgents((current) => ({
      ...current,
      [role]: { ...current[role], ...patch },
    }));
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[6vh]"
      {...backdropDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Custom workflow settings"
        className="flex w-full max-w-3xl flex-col rounded-lg border bg-background p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Custom workflow settings</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              These settings apply only to this workflow run.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close custom workflow settings"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>

        <label className="mt-5 text-sm font-medium" htmlFor="custom-workflow">
          Workflow
        </label>
        <select
          id="custom-workflow"
          className="mt-2 h-9 rounded-md border bg-background px-3 text-sm"
          value={workflowId}
          onChange={(event) => setWorkflowId(Number(event.target.value))}
        >
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </select>

        {ROLES.map((role) => {
          const config = agents[role];
          const values: Partial<Record<CodingAgent, AgentSettingValues>> = {
            [config.runtime]: {
              model: config.model,
              effort: config.effort,
            },
          };
          return (
            <section key={role} className="mt-5">
              <h3 className="text-sm font-medium capitalize">{role}</h3>
              <CodingAgentSettingsList
                name={`custom-workflow-${role}`}
                label={`${role} coding agent`}
                selected={config.runtime}
                values={values}
                disabled={false}
                saving={false}
                onSelectAgent={(runtime) =>
                  update(role, { runtime, model: "", effort: "" })
                }
                onSaveModel={(runtime, model, effort) =>
                  update(role, { runtime, model, effort })
                }
              />
            </section>
          );
        })}

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!workflowId}
            onClick={() => onStart(workflowId, agents)}
          >
            Start workflow
          </Button>
        </div>
      </div>
    </div>
  );
}
