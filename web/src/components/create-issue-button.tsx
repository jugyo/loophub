// "New issue" launcher. Issues are filed by an AI (Claude Code etc.) via the /lh-issue-create
// skill, not by hand, so the button launches that skill as a Herdr session scoped to the repo
// whose issue list is in view. The backend create API (useCreateIssue) stays for the skill/CLI
// to use.

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
import { useSettings } from "@/queries/settings";

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
  disabled = false,
}: {
  repo: string;
  disabled?: boolean;
}) {
  const { launchTerminal } = useTerminalLauncher();
  const { data: settings } = useSettings();
  const [menuOpen, setMenuOpen] = useState(false);

  function launchIssue(override?: { agent: CodingAgent; model: string }) {
    setMenuOpen(false);
    const model = override?.model.trim();
    launchTerminal({
      repo,
      label: `New issue - ${launchSuffix()}`,
      workflow: "issue-create",
      ...(override ? { agent: override.agent, model: model || undefined } : {}),
    });
  }

  return (
    <div className="inline-flex">
      <Button
        aria-label="New issue"
        title="New issue"
        disabled={disabled}
        className="rounded-r-none"
        onClick={() => launchIssue()}
      >
        <Plus className="size-4" />
        New issue
      </Button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Choose agent and model"
            title="Choose agent and model for this issue creation"
            disabled={disabled || !settings}
            className="rounded-l-none border-l border-primary-foreground/25 px-2"
          >
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        {settings ? (
          <DropdownMenuContent align="end" className="w-72 p-3">
            <AgentModelPicker
              settings={settings}
              disabled={false}
              actionVerb="Create"
              actionIcon={<Plus className="size-4" />}
              onSelect={(agent, model) => launchIssue({ agent, model })}
            />
          </DropdownMenuContent>
        ) : null}
      </DropdownMenu>
    </div>
  );
}
