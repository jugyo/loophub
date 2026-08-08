// Instance-level settings (#474) — the first entry point for global config.json settings, as
// opposed to the per-repo settings screen (see repo-settings-page.tsx's MergeModeSection).

import { ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";
import type { CodingAgent } from "@/api/types";
import { SettingsLayout } from "@/components/settings-header";
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
import { useSettings, useUpdateSettings } from "@/queries/settings";
import { CODING_AGENTS } from "../../../core/runtimes.ts";

// Built from the runtime registry order (core/runtimes.ts, via CODING_AGENTS) + its labels, so the
// picker lists every runtime without a hand-maintained copy here.
const CODING_AGENT_OPTIONS: {
  value: CodingAgent;
  label: string;
}[] = CODING_AGENTS.map((value) => ({
  value,
  label: CODING_AGENT_LABELS[value],
}));

function displayValue(value: string): string {
  if (value === "xhigh") return "Extra high";
  return value
    .replace(/[/_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .replace(/^Gpt\b/, "GPT");
}

function moneyInputValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function validateDevCostLimit(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return "Enter a dollar amount with up to two decimal places.";
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "Enter an amount greater than $0.";
  }
  if (parsed > 1000) {
    return "Enter an amount no greater than $1,000.";
  }
  return null;
}

function AgentModelDropdown({
  agentLabel,
  model,
  effort,
  modelSuggestions,
  effortSuggestions,
  disabled,
  saving,
  onSave,
}: {
  agentLabel: string;
  model: string;
  effort: string;
  modelSuggestions: string[];
  effortSuggestions: string[];
  disabled: boolean;
  saving: boolean;
  onSave: (model: string, effort: string) => void;
}) {
  const models = modelSuggestions.includes(model)
    ? modelSuggestions
    : [model, ...modelSuggestions];
  const efforts = effortSuggestions.includes(effort)
    ? effortSuggestions
    : effort
      ? [effort, ...effortSuggestions]
      : effortSuggestions;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          aria-label={`${agentLabel} model`}
          title={model ? displayValue(model) : "Default"}
          disabled={disabled || saving}
          className="min-w-44 justify-between border bg-background px-3 text-left font-normal shadow-sm"
        >
          <span className="min-w-0 truncate">
            {model ? displayValue(model) : "Default"}
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
                      key={candidateEffort}
                      onSelect={() => onSave(candidate, candidateEffort)}
                      aria-current={selected ? "true" : undefined}
                      className={cn(
                        "justify-between",
                        selected && "bg-accent text-accent-foreground",
                      )}
                    >
                      {displayValue(candidateEffort)}
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

export function SettingsPage() {
  const { data, isLoading } = useSettings();
  const update = useUpdateSettings();
  const devCostLimitUsd = data?.devCostLimitUsd ?? 10;
  const [devCostLimitInput, setDevCostLimitInput] = useState(
    moneyInputValue(devCostLimitUsd),
  );

  useEffect(() => {
    setDevCostLimitInput(moneyInputValue(devCostLimitUsd));
  }, [devCostLimitUsd]);

  const codingAgent = data?.codingAgent ?? "claude-code";
  const devCostLimitError = validateDevCostLimit(devCostLimitInput);
  const parsedDevCostLimit = Number(devCostLimitInput.trim());
  const devCostLimitChanged =
    !devCostLimitError && parsedDevCostLimit !== devCostLimitUsd;

  return (
    <div data-debug-component="SettingsPage">
      <SettingsLayout section="agent">
        <section data-debug-component="CodingAgentSettings">
          <h2 className="text-sm font-medium">Coding agent</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Default coding agent for builds.
          </p>
          <div
            role="radiogroup"
            aria-label="Coding agent"
            className="mt-3 max-w-2xl rounded-md border"
          >
            {CODING_AGENT_OPTIONS.map((agentOption) => {
              const model = data?.agents?.[agentOption.value]?.model ?? "";
              const effort = data?.agents?.[agentOption.value]?.effort ?? "";
              return (
                <div
                  key={agentOption.value}
                  className="flex items-center gap-4 border-b px-3 py-3 last:border-b-0"
                >
                  <input
                    type="radio"
                    name="coding-agent"
                    value={agentOption.value}
                    aria-label={agentOption.label}
                    checked={codingAgent === agentOption.value}
                    disabled={isLoading || update.isPending}
                    className="size-4 accent-primary"
                    onChange={() =>
                      update.mutate({ codingAgent: agentOption.value })
                    }
                  />
                  <span className="w-32 shrink-0 font-medium">
                    {agentOption.label}
                  </span>
                  <AgentModelDropdown
                    agentLabel={agentOption.label}
                    model={model}
                    effort={effort}
                    modelSuggestions={MODEL_SUGGESTIONS[agentOption.value]}
                    effortSuggestions={EFFORT_SUGGESTIONS[agentOption.value]}
                    disabled={isLoading}
                    saving={update.isPending}
                    onSave={(selectedModel, selectedEffort) =>
                      update.mutate({
                        agent: agentOption.value,
                        model: selectedModel,
                        effort: selectedEffort,
                      })
                    }
                  />
                  {EFFORT_SUGGESTIONS[agentOption.value].length === 0 ? (
                    <span
                      aria-label={`${agentOption.label} effort not supported`}
                      className="shrink-0 text-muted-foreground"
                    >
                      —
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section
          data-debug-component="CostLimitSettings"
          className="mt-8 max-w-md"
        >
          <h2 className="text-sm font-medium">Task over-budget limit</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Stop a running build agent after its task cost exceeds this amount.
          </p>
          <form
            className="mt-3 flex items-start gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (devCostLimitError || !devCostLimitChanged) return;
              update.mutate({ devCostLimitUsd: parsedDevCostLimit });
            }}
          >
            <label className="flex-1 text-sm">
              <span className="sr-only">Task over-budget limit in USD</span>
              <span className="flex rounded-md border bg-background shadow-sm focus-within:outline-none focus-within:ring-2 focus-within:ring-ring">
                <span className="select-none border-r px-3 py-2 text-muted-foreground">
                  $
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={devCostLimitInput}
                  disabled={isLoading || update.isPending}
                  aria-label="Task over-budget limit in USD"
                  aria-invalid={devCostLimitError ? "true" : undefined}
                  aria-describedby={
                    devCostLimitError ? "dev-cost-limit-error" : undefined
                  }
                  className="min-w-0 flex-1 bg-transparent px-3 py-2 tabular-nums outline-none disabled:opacity-50"
                  onChange={(event) => setDevCostLimitInput(event.target.value)}
                />
              </span>
            </label>
            <Button
              type="submit"
              variant="secondary"
              disabled={
                isLoading ||
                update.isPending ||
                Boolean(devCostLimitError) ||
                !devCostLimitChanged
              }
            >
              Save
            </Button>
          </form>
          {devCostLimitError ? (
            <p id="dev-cost-limit-error" className="mt-2 text-sm text-red-600">
              {devCostLimitError}
            </p>
          ) : null}
        </section>
      </SettingsLayout>
    </div>
  );
}
