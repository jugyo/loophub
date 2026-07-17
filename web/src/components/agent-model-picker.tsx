import { type ReactNode, useId, useState } from "react";
import type { CodingAgent, GlobalSettings } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CODING_AGENT_LABELS,
  EFFORT_SUGGESTIONS,
  MODEL_SUGGESTIONS,
} from "@/lib/agent-models";
import { cn } from "@/lib/utils";

// Shared one-shot runtime/model/effort picker for launches such as New issue. It starts from
// the caller's defaults (repo effective config for New issue, #1534) but only returns the
// selection to the caller; it never persists changes. When the user switches agent, model and
// effort fall back to that agent's app Settings defaults.
export function AgentModelPicker({
  settings,
  defaults,
  disabled,
  actionVerb,
  actionIcon,
  onSelect,
}: {
  settings: GlobalSettings;
  // Initial selection shown when the menu opens. For New issue this is the repo's effective
  // Coding agent config so the dialog reflects what an un-overridden launch would use (#1534).
  defaults: { agent: CodingAgent; model: string; effort: string };
  disabled: boolean;
  actionVerb: string;
  actionIcon: ReactNode;
  onSelect: (agent: CodingAgent, model: string, effort: string) => void;
}) {
  const [agent, setAgent] = useState<CodingAgent>(defaults.agent);
  const [model, setModel] = useState(defaults.model);
  const [effort, setEffort] = useState(defaults.effort);
  const customModelId = useId();

  function selectAgent(next: CodingAgent) {
    setAgent(next);
    setModel(settings.agents[next]?.model ?? "");
    setEffort(settings.agents[next]?.effort ?? "");
  }

  return (
    <>
      <p className="mb-1 text-xs font-medium text-muted-foreground">Agent</p>
      <div className="mb-3 flex gap-1">
        {(Object.keys(CODING_AGENT_LABELS) as CodingAgent[]).map(
          (candidate) => {
            const active = agent === candidate;
            return (
              <button
                key={candidate}
                type="button"
                aria-pressed={active}
                className={cn(
                  "flex-1 rounded-md border px-2 py-1.5 text-sm",
                  active
                    ? "border-primary bg-primary/10 font-medium"
                    : "hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => selectAgent(candidate)}
              >
                {CODING_AGENT_LABELS[candidate]}
              </button>
            );
          },
        )}
      </div>

      <p className="mb-1 block text-xs font-medium text-muted-foreground">
        Model
      </p>
      <ModelDropdown
        agent={agent}
        model={model}
        disabled={disabled}
        onChange={setModel}
      />
      <label
        htmlFor={`${customModelId}-custom-model`}
        className="mt-3 mb-1 block text-xs font-medium text-muted-foreground"
      >
        Custom model
      </label>
      <input
        id={`${customModelId}-custom-model`}
        type="text"
        placeholder="Default"
        className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        value={model}
        disabled={disabled}
        onChange={(event) => setModel(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") return;
          event.stopPropagation();
        }}
      />

      <p className="mt-3 mb-1 block text-xs font-medium text-muted-foreground">
        Effort
      </p>
      <EffortDropdown
        agent={agent}
        effort={effort}
        disabled={disabled}
        onChange={setEffort}
      />

      <Button
        className="mt-3 w-full"
        disabled={disabled}
        onClick={() => onSelect(agent, model, effort)}
      >
        {actionIcon}
        {actionVerb} with {CODING_AGENT_LABELS[agent]}
      </Button>
    </>
  );
}

function ModelDropdown({
  agent,
  model,
  disabled,
  onChange,
}: {
  agent: CodingAgent;
  model: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const suggestions = MODEL_SUGGESTIONS[agent];
  const options = suggestions.includes(model)
    ? suggestions
    : [model, ...suggestions];

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        aria-label="Model"
        title={model || "Default"}
        disabled={disabled}
        className="w-full justify-between border bg-background px-3 font-normal shadow-sm"
      >
        <span className="min-w-0 truncate">{model || "Default"}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[min(20rem,calc(100vh-5rem))] min-w-56 overflow-y-auto">
        {options.map((candidate) => {
          const selected = candidate === model;
          return (
            <DropdownMenuItem
              key={candidate || "__default__"}
              onSelect={(event) => {
                event.preventDefault();
                onChange(candidate);
              }}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "justify-between",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 truncate">{candidate || "Default"}</span>
              {selected ? <DropdownMenuItemIndicator /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function EffortDropdown({
  agent,
  effort,
  disabled,
  onChange,
}: {
  agent: CodingAgent;
  effort: string;
  disabled: boolean;
  onChange: (effort: string) => void;
}) {
  const suggestions = EFFORT_SUGGESTIONS[agent];
  const options = suggestions.includes(effort)
    ? suggestions
    : effort
      ? [effort, ...suggestions]
      : suggestions;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        aria-label="Effort"
        title={effort || "Default"}
        disabled={disabled}
        className="w-full justify-between border bg-background px-3 font-normal shadow-sm"
      >
        <span className="min-w-0 truncate">{effort || "Default"}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[min(20rem,calc(100vh-5rem))] min-w-40 overflow-y-auto">
        {options.map((candidate) => {
          const selected = candidate === effort;
          return (
            <DropdownMenuItem
              key={candidate || "__default__"}
              onSelect={(event) => {
                event.preventDefault();
                onChange(candidate);
              }}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "justify-between",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 truncate">{candidate || "Default"}</span>
              {selected ? <DropdownMenuItemIndicator /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
