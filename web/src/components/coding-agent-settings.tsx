// Shared Coding agent settings list (#165). Both the application Settings screen
// (settings-page.tsx) and the per-repo Agent settings (repo-settings-page.tsx's AgentConfigSection)
// render the same rows — one per registry runtime, each with a radio that picks the active agent and
// a dropdown that edits that agent's model (plus effort, for runtimes that offer levels) — so the two
// screens share one layout, one set of labels, and one way to edit. The only per-screen difference is
// the repo's override semantics: there an empty model/effort means "use the runtime default", so that
// screen opts into an explicit Default entry via `allowDefault`.

import { ChevronsUpDown } from "lucide-react";
import type { CodingAgent } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CODING_AGENT_LABELS,
  EFFORT_SUGGESTIONS,
  MODEL_SUGGESTIONS,
} from "@/lib/agent-models";
import { cn } from "@/lib/utils";
import { CODING_AGENTS } from "../../../core/runtimes.ts";

export type AgentSettingValues = { model: string; effort: string };

const NO_VALUES: AgentSettingValues = { model: "", effort: "" };

export function displayValue(value: string): string {
  if (value === "xhigh") return "Extra high";
  return value
    .replace(/[/_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .replace(/^Gpt\b/, "GPT");
}

// One-line summary of a runtime/model/effort triple, in the same wording the rows use.
export function agentConfigSummary(config: {
  runtime: CodingAgent;
  model: string;
  effort: string;
}): string {
  return [
    CODING_AGENT_LABELS[config.runtime],
    config.model ? displayValue(config.model) : "Default",
    config.effort ? displayValue(config.effort) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function CodingAgentSettingsList({
  name,
  label,
  selected,
  values,
  allowDefault = false,
  disabled,
  saving,
  onSelectAgent,
  onSaveModel,
}: {
  // `name` groups the row radios; it must be unique among radio groups on the screen.
  name: string;
  label: string;
  selected: CodingAgent;
  // Saved model/effort per agent. The repo screen stores one triple, so it fills in only the
  // selected agent and the other rows read as Default.
  values: Partial<Record<CodingAgent, AgentSettingValues>>;
  allowDefault?: boolean;
  disabled: boolean;
  saving: boolean;
  onSelectAgent: (agent: CodingAgent) => void;
  onSaveModel: (agent: CodingAgent, model: string, effort: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="mt-3 max-w-2xl rounded-md border"
      data-debug-component="CodingAgentSettingsList"
    >
      {CODING_AGENTS.map((agent) => {
        const agentLabel = CODING_AGENT_LABELS[agent];
        const { model, effort } = values[agent] ?? NO_VALUES;
        return (
          <div
            key={agent}
            className="flex items-center gap-4 border-b px-3 py-3 last:border-b-0"
          >
            <input
              id={`${name}-${agent}`}
              type="radio"
              name={name}
              value={agent}
              aria-label={agentLabel}
              checked={selected === agent}
              disabled={disabled || saving}
              className="size-4 accent-primary"
              onChange={() => onSelectAgent(agent)}
            />
            <label
              htmlFor={`${name}-${agent}`}
              className="w-32 shrink-0 font-medium"
            >
              {agentLabel}
            </label>
            <AgentModelDropdown
              agentLabel={agentLabel}
              model={model}
              effort={effort}
              modelSuggestions={MODEL_SUGGESTIONS[agent]}
              effortSuggestions={EFFORT_SUGGESTIONS[agent]}
              allowDefault={allowDefault}
              disabled={disabled}
              saving={saving}
              onSave={(selectedModel, selectedEffort) =>
                onSaveModel(agent, selectedModel, selectedEffort)
              }
            />
          </div>
        );
      })}
    </div>
  );
}

function AgentModelDropdown({
  agentLabel,
  model,
  effort,
  modelSuggestions,
  effortSuggestions,
  allowDefault,
  disabled,
  saving,
  onSave,
}: {
  agentLabel: string;
  model: string;
  effort: string;
  modelSuggestions: string[];
  effortSuggestions: string[];
  allowDefault: boolean;
  disabled: boolean;
  saving: boolean;
  onSave: (model: string, effort: string) => void;
}) {
  // A saved value outside the suggestions is injected so existing config stays visible. With
  // `allowDefault` the empty value is offered too, so an override can be handed back to the runtime.
  const modelOptions = allowDefault
    ? ["", ...modelSuggestions]
    : modelSuggestions;
  const models = modelOptions.includes(model)
    ? modelOptions
    : [model, ...modelOptions];
  const effortOptions = allowDefault
    ? ["", ...effortSuggestions]
    : effortSuggestions;
  const efforts = effortOptions.includes(effort)
    ? effortOptions
    : effort
      ? [effort, ...effortOptions]
      : effortOptions;
  // Summarize the saved selection on the closed trigger (#100) so model and effort are both
  // readable without opening the submenu. Agents whose registry entry offers no effort levels
  // never save one, so they show the model alone instead of an empty separator.
  const modelText = model ? displayValue(model) : "Default";
  const effortText =
    effortSuggestions.length > 0 && effort ? displayValue(effort) : "";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          aria-label={`${agentLabel} model`}
          title={effortText ? `${modelText} · ${effortText}` : modelText}
          disabled={disabled || saving}
          className="min-w-44 justify-between border bg-background px-3 text-left font-normal shadow-sm"
        >
          <span className="min-w-0 truncate">
            {modelText}
            {effortText ? (
              <span className="text-muted-foreground"> · {effortText}</span>
            ) : null}
          </span>
          <ChevronsUpDown
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(24rem,calc(100vh-5rem))] min-w-56 overflow-y-auto"
      >
        {models.map((candidate) => {
          const selectedModel = candidate === model;
          if (effortSuggestions.length === 0) {
            return (
              <DropdownMenuItem
                key={candidate || "__default__"}
                onSelect={() => onSave(candidate, "")}
                aria-current={selectedModel ? "true" : undefined}
                className={cn(
                  "justify-between",
                  selectedModel && "bg-accent text-accent-foreground",
                )}
              >
                <span className="min-w-0 truncate">
                  {candidate ? displayValue(candidate) : "Default"}
                </span>
                {selectedModel ? <DropdownMenuItemIndicator /> : null}
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuSub key={candidate || "__default__"}>
              <DropdownMenuSubTrigger
                aria-label={`${candidate ? displayValue(candidate) : "Default"} effort options`}
                className={cn(
                  selectedModel && "bg-accent text-accent-foreground",
                )}
              >
                <span className="min-w-0 truncate">
                  {candidate ? displayValue(candidate) : "Default"}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-[min(24rem,calc(100vh-5rem))] min-w-40 overflow-y-auto">
                {efforts.map((candidateEffort) => {
                  const selected = selectedModel && candidateEffort === effort;
                  return (
                    <DropdownMenuItem
                      key={candidateEffort || "__default__"}
                      onSelect={() => onSave(candidate, candidateEffort)}
                      aria-current={selected ? "true" : undefined}
                      className={cn(
                        "justify-between",
                        selected && "bg-accent text-accent-foreground",
                      )}
                    >
                      {candidateEffort
                        ? displayValue(candidateEffort)
                        : "Default"}
                      {selected ? <DropdownMenuItemIndicator /> : null}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
