// "New issue" launcher. The button gives the agent the filing instructions directly; the
// /lh-issue-create skill remains available for compatibility when invoked separately.

import { ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import type { CodingAgent } from "@/api/types";
import { AgentModelPicker } from "@/components/agent-model-picker";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRepoAgentConfig } from "@/queries/repos";
import { useSettings } from "@/queries/settings";

const ISSUE_CREATE_PROMPT = `Create an AFK-ready LoopHub issue from the user's request, then stop.

Gather only the missing context needed to file the issue: a concise title, whether it is a bug or enhancement when unclear, the goal, verifiable acceptance criteria, and any related resources explicitly mentioned by the user. If there is no request context yet, ask exactly one open question: "What's going on?" Ask small follow-up questions only for genuinely missing information.

Check for likely duplicate issues before filing. Once enough information is available, create the issue in the current repository with \`lh issue create\`, including the title, body, acceptance criteria, and related resources. Report the created issue number and stop. Do not implement the issue, create a branch, open a PR, or merge anything.`;

// Unlike Issue/PR/Resume launches (#497), there is no issue number yet to make the herdr agent
// name unique — the issue doesn't exist until the launched session files it. A random suffix
// keeps consecutive New Issue launches from colliding on the same agent name (`agent_name_taken`,
// #501); unlike a Date.now() timestamp, it can't collide even when two launches land in the same
// millisecond.
function launchSuffix(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

export function CreateIssueButton({
  repo,
  targetBranch,
  disabled = false,
}: {
  repo: string;
  targetBranch?: string;
  disabled?: boolean;
}) {
  const { launchTerminal } = useTerminalLauncher();
  const { data: settings } = useSettings();
  // Same resolution path as `lh workflow start` / `lh issue new`: repos/agentConfig → effective
  // runtime/model/effort (#1532/#1534). Seeds the one-shot picker; the plain button omits
  // overrides so the CLI resolves the effective config itself.
  const [owner, name] = repo.split("/");
  const { data: agentConfig } = useRepoAgentConfig(owner ?? "", name ?? "");
  const [menuOpen, setMenuOpen] = useState(false);

  const effective = agentConfig?.effective;
  const pickerReady = Boolean(settings && effective);

  function launchIssue(override?: {
    agent: CodingAgent;
    model: string;
    effort: string;
  }) {
    setMenuOpen(false);
    const model = override?.model.trim();
    const effort = override?.effort.trim();
    launchTerminal({
      repo,
      label: `New issue - ${launchSuffix()}`,
      workflow: "issue-create",
      prompt: ISSUE_CREATE_PROMPT,
      ...(targetBranch ? { targetBranch } : {}),
      ...(override
        ? {
            agent: override.agent,
            model: model || undefined,
            effort: effort || undefined,
          }
        : {}),
    });
  }

  return (
    <div data-debug-component="CreateIssueButton" className="inline-flex">
      <Button
        aria-label="New issue"
        title="New issue"
        disabled={disabled}
        className="rounded-r-none"
        onClick={() => launchIssue()}
      >
        <Plus className="size-4" />
        <span>New issue</span>
        {targetBranch ? (
          <span className="font-normal opacity-75">in {targetBranch}</span>
        ) : null}
      </Button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Choose agent and model"
            title="Choose agent and model for this issue creation"
            disabled={disabled || !pickerReady}
            className="rounded-l-none border-l border-primary-foreground/25 px-2"
          >
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        {settings && effective ? (
          <DropdownMenuContent align="end" className="w-72 p-3">
            <AgentModelPicker
              key={`${effective.runtime}:${effective.model}:${effective.effort}`}
              settings={settings}
              defaults={{
                agent: effective.runtime,
                model: effective.model,
                effort: effective.effort,
              }}
              disabled={false}
              actionVerb="Create"
              actionIcon={<Plus className="size-4" />}
              onSelect={(agent, model, effort) =>
                launchIssue({ agent, model, effort })
              }
            />
          </DropdownMenuContent>
        ) : null}
      </DropdownMenu>
    </div>
  );
}
