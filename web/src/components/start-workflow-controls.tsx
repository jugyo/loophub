import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Loader2, Workflow } from "lucide-react";
import { useState } from "react";
import type { Issue } from "@/api/types";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkerLaunchUnavailable } from "@/components/worker-compatibility-warning";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { useRepoAgentConfig } from "@/queries/repos";
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
  // The workflow picker starts a run with the repo's effective Coding agent config
  // (override on → repo values, off → application Settings defaults), so surface the
  // resolved runtime/model/effort in the menu the launch is triggered from (#96).
  const { data: agentConfig } = useRepoAgentConfig(owner, repo);
  const effective = agentConfig?.effective;
  const { canStartWorkflow, showRemediation } = useWorkerLaunchGate();
  const [isLaunching, startLaunching] = useFixedLoading();
  const [menuOpen, setMenuOpen] = useState(false);
  const workflowList = Array.isArray(workflows) ? workflows : [];

  // Launch with the repo effective agent/model (no one-shot override). The
  // terminal / CLI path resolves runtime from repo config when agent and model
  // are omitted.
  function start(workflowId: number) {
    startLaunching();
    setMenuOpen(false);
    launchTerminal({
      repo: fullRepo,
      label: `Issue #${issue.number} - ${issue.title}`,
      workflow: "workflow-run",
      issueNumber: issue.number,
      workflowId,
    });
  }

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={compact ? "secondary" : undefined}
          size={compact ? "sm" : undefined}
          className={compact ? "h-6 gap-1 px-2 text-xs font-normal" : undefined}
          title="Start a saved workflow in auto mode (no approval prompts, no sandbox)"
          disabled={isLaunching || isLoading || !canStartWorkflow}
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
        {workflowList.length > 0 ? (
          workflowList.map((workflow) => (
            <DropdownMenuItem
              key={workflow.id}
              onSelect={(event) => {
                event.preventDefault();
                start(workflow.id);
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
        {effective ? (
          <>
            <DropdownMenuSeparator />
            <p className="px-1.5 py-1 text-right text-xs leading-relaxed text-muted-foreground">
              {effective.runtime} · {effective.model} · {effective.effort}
            </p>
          </>
        ) : null}
      </DropdownMenuContent>
      {showRemediation ? <WorkerLaunchUnavailable compact={compact} /> : null}
    </DropdownMenu>
  );
}
