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
import { CODING_AGENT_LABELS, MODEL_SUGGESTIONS } from "@/lib/agent-models";
import { cn } from "@/lib/utils";

// Shared one-shot runtime/model picker for launches such as Build and New issue. It starts from
// Settings defaults but only returns the selection to the caller; it never persists changes.
export function AgentModelPicker({
  settings,
  disabled,
  actionVerb,
  actionIcon,
  onSelect,
}: {
  settings: GlobalSettings;
  disabled: boolean;
  actionVerb: string;
  actionIcon: ReactNode;
  onSelect: (agent: CodingAgent, model: string) => void;
}) {
  const [agent, setAgent] = useState<CodingAgent>(settings.codingAgent);
  const [model, setModel] = useState(
    settings.agents[settings.codingAgent]?.model ?? "",
  );
  const customModelId = useId();

  function selectAgent(next: CodingAgent) {
    setAgent(next);
    setModel(settings.agents[next]?.model ?? "");
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

      <Button
        className="mt-3 w-full"
        disabled={disabled}
        onClick={() => onSelect(agent, model)}
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
