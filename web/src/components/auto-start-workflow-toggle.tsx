// Repo-level "Auto-start workflow" switch for the issue list (#2626). While on, lh-worker starts the
// chosen saved workflow for every issue opened from then on. Turning it on asks which workflow
// (the same list Start workflow offers); runs use the repo's Coding agent settings.

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { useRepo, useSetRepoAutoStartWorkflow } from "@/queries/repos";
import { useWorkflows } from "@/queries/workflows";

export function AutoStartWorkflowToggle({
  owner,
  repo,
  className,
}: {
  owner: string;
  repo: string;
  className?: string;
}) {
  const { data: repoData } = useRepo(owner, repo);
  const { data: workflows } = useWorkflows({
    applicableToRepo: `${owner}/${repo}`,
  });
  const setAutoStart = useSetRepoAutoStartWorkflow(owner, repo);
  const [pickerOpen, setPickerOpen] = useState(false);
  const workflowList = Array.isArray(workflows) ? workflows : [];
  const workflowId = repoData?.auto_start_workflow_id ?? null;
  const selected = workflowList.find((w) => w.id === workflowId);

  return (
    <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
      <span
        data-debug-component="AutoStartWorkflowToggle"
        className={className ?? "relative inline-flex h-9 items-center"}
        title={
          workflowId === null
            ? "Start a workflow automatically for new issues"
            : `Starts "${selected?.name ?? `workflow ${workflowId}`}" for new issues`
        }
      >
        <Switch
          label="Auto-start workflow"
          className="text-sm"
          checked={workflowId !== null}
          onCheckedChange={(checked) => {
            if (checked) setPickerOpen(true);
            else setAutoStart.mutate(null);
          }}
        />
        {/* Zero-size anchor so the workflow picker opens under the switch. */}
        <DropdownMenuTrigger asChild>
          <span aria-hidden="true" className="absolute right-0 bottom-0" />
        </DropdownMenuTrigger>
      </span>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Workflow to start for new issues</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workflowList.length > 0 ? (
          workflowList.map((workflow) => (
            <DropdownMenuItem
              key={workflow.id}
              onSelect={() => setAutoStart.mutate(workflow.id)}
              className="flex-col items-start gap-1 px-3 py-2 whitespace-normal"
            >
              <span className="font-medium leading-tight">{workflow.name}</span>
              {workflow.description ? (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {workflow.description}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem disabled>No saved workflows</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
