import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown, Loader2, Workflow } from "lucide-react";
import { useState } from "react";
import type { CodingAgent, Issue } from "@/api/types";
import { AgentModelPicker } from "@/components/agent-model-picker";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkerLaunchUnavailable } from "@/components/worker-compatibility-warning";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { useRepoAgentConfig } from "@/queries/repos";
import { useSettings } from "@/queries/settings";
import { useWorkerLaunchGate } from "@/queries/worker-status";
import { useWorkflows } from "@/queries/workflows";

export function StartWorkflowControls({
  owner,
  repo,
  issue,
  compact = false,
}: {
  owner: string;
  repo: string;
  issue: Issue;
  compact?: boolean;
}) {
  const fullRepo = `${owner}/${repo}`;
  const { launchTerminal } = useTerminalLauncher();
  const navigate = useNavigate();
  const { data: workflows, isLoading } = useWorkflows({
    applicableToRepo: fullRepo,
  });
  const { data: settings } = useSettings();
  const { data: agentConfig } = useRepoAgentConfig(owner, repo);
  const { canStartWorkflow, showRemediation } = useWorkerLaunchGate();
  const [isLaunching, startLaunching] = useFixedLoading();
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<number | null>(
    null,
  );
  const effective = agentConfig?.effective;
  const workflowList = Array.isArray(workflows) ? workflows : [];
  const selectedWorkflow = workflowList.find(
    (workflow) => workflow.id === selectedWorkflowId,
  );

  function start(
    workflowId: number,
    override: { agent: CodingAgent; model: string },
  ) {
    startLaunching();
    setMenuOpen(false);
    launchTerminal({
      repo: fullRepo,
      label: `Issue #${issue.number} - ${issue.title}`,
      workflow: "workflow-run",
      issueNumber: issue.number,
      workflowId,
      agent: override.agent,
      model: override.model.trim() || undefined,
    });
  }

  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (!open) setSelectedWorkflowId(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant={compact ? "secondary" : undefined}
          size={compact ? "sm" : undefined}
          className={compact ? "h-6 gap-1 px-2 text-xs font-normal" : undefined}
          title="Choose a saved workflow, agent, and model"
          disabled={
            isLaunching ||
            isLoading ||
            !settings ||
            !effective ||
            !canStartWorkflow
          }
        >
          {isLaunching ? (
            <Loader2
              className={
                compact ? "size-3 animate-spin" : "size-4 animate-spin"
              }
            />
          ) : (
            <Workflow className={compact ? "size-3" : "size-4"} />
          )}
          Start workflow
          <ChevronDown className={compact ? "size-3" : "size-4"} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={compact ? "start" : "end"} className="w-80">
        {selectedWorkflow && settings && effective ? (
          <>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setSelectedWorkflowId(null);
              }}
            >
              <ArrowLeft className="size-4" />
              Back to workflows
            </DropdownMenuItem>
            <div className="border-t p-3">
              <p className="mb-3 font-medium">{selectedWorkflow.name}</p>
              <AgentModelPicker
                key={`${selectedWorkflow.id}:${effective.runtime}:${effective.model}`}
                settings={settings}
                defaults={{
                  agent: effective.runtime,
                  model: effective.model,
                  effort: effective.effort,
                }}
                disabled={isLaunching}
                showEffort={false}
                actionVerb="Start workflow"
                actionIcon={<Workflow className="size-4" />}
                onSelect={(agent, model) =>
                  start(selectedWorkflow.id, { agent, model })
                }
              />
            </div>
          </>
        ) : workflowList.length > 0 && settings && effective ? (
          workflowList.map((workflow) => (
            <DropdownMenuItem
              key={workflow.id}
              onSelect={(event) => {
                event.preventDefault();
                setSelectedWorkflowId(workflow.id);
              }}
              className="flex-col items-start gap-1 px-3 py-3 whitespace-normal"
            >
              <div className="flex w-full min-w-0 items-baseline gap-2">
                <span className="min-w-0 font-medium leading-tight">
                  {workflow.name}
                </span>
                {workflow.scope.kind === "repository" ? (
                  <span className="shrink-0 text-xs leading-tight text-muted-foreground">
                    {workflow.scope.repo.owner}/{workflow.scope.repo.name}
                  </span>
                ) : null}
              </div>
              {workflow.description ? (
                <span className="line-clamp-3 w-full min-w-0 break-words text-xs leading-relaxed text-muted-foreground">
                  {workflow.description}
                </span>
              ) : null}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              navigate({ to: "/settings/workflows" });
            }}
          >
            No saved workflows — set one up in Settings
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
      {showRemediation ? <WorkerLaunchUnavailable compact={compact} /> : null}
    </DropdownMenu>
  );
}
