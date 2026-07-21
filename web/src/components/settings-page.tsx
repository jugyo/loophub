// Instance-level settings (#474) — the first entry point for global config.json settings, as
// opposed to the per-repo settings screen (see repo-settings-page.tsx's MergeModeSection).

import { Link } from "@tanstack/react-router";
import { Check, ChevronsUpDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { CodingAgent } from "@/api/types";
import { Button, disabledButtonStateClasses } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
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

function autoModeOptions(): { value: boolean; label: string }[] {
  return [
    {
      value: false,
      label: "Off",
    },
    {
      value: true,
      label: "On",
    },
  ];
}

// Built from the runtime registry order (core/runtimes.ts, via CODING_AGENTS) + its labels, so the
// picker lists every runtime without a hand-maintained copy here.
const CODING_AGENT_OPTIONS: {
  value: CodingAgent;
  label: string;
}[] = CODING_AGENTS.map((value) => ({
  value,
  label: CODING_AGENT_LABELS[value],
}));

// Serializes a model+effort pair into one <select> option value. "::" is safe as a separator:
// no entry in MODEL_SUGGESTIONS/EFFORT_SUGGESTIONS contains it.
function comboValue(model: string, effort: string): string {
  return `${model}::${effort}`;
}

function parseComboValue(value: string): { model: string; effort: string } {
  const separator = value.lastIndexOf("::");
  if (separator === -1) return { model: value, effort: "" };
  return {
    model: value.slice(0, separator),
    effort: value.slice(separator + 2),
  };
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

// A single agent's "Default model & effort" picker (#594, #610, #682). Options are the full
// model x effort combination, so a selection always saves a valid pair and an invalid combination
// can never be chosen. If the currently persisted pair isn't one of the combinations (e.g. a model
// saved before effort existed, or a value typed via the old free-text field), it's injected as an
// extra leading option so the picker still reflects the real saved state instead of silently jumping
// to something else (#682 AC: "existing settings select the right combination").
function modelEffortLabel(model: string, effort: string): string {
  if (!model && !effort) return "Select model & effort";
  if (!model) return `Default — ${effort}`;
  if (!effort) return `${model} — default`;
  return `${model} — ${effort}`;
}

function AgentModelEffortDropdown({
  label,
  model,
  effort,
  modelSuggestions,
  effortSuggestions,
  disabled,
  saving,
  onSave,
}: {
  label: string;
  model: string;
  effort: string;
  modelSuggestions: string[];
  effortSuggestions: string[];
  disabled: boolean;
  saving: boolean;
  onSave: (model: string, effort: string) => void;
}) {
  const combos = modelSuggestions.flatMap((m) =>
    effortSuggestions.map((e) => ({ model: m, effort: e })),
  );
  const currentValue = comboValue(model, effort);
  const hasCurrent = combos.some(
    (c) => comboValue(c.model, c.effort) === currentValue,
  );
  const options = hasCurrent ? combos : [{ model, effort }, ...combos];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          aria-label={`Default model and effort (${label})`}
          title={modelEffortLabel(model, effort)}
          disabled={disabled || saving}
          className="w-full max-w-md justify-between border bg-background px-3 text-left font-normal shadow-sm"
        >
          <span className="min-w-0 truncate">
            {modelEffortLabel(model, effort)}
          </span>
          <ChevronsUpDown
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(24rem,calc(100vh-5rem))] w-[var(--radix-dropdown-menu-trigger-width)] min-w-72 overflow-y-auto"
      >
        {options.map((o) => {
          const value = comboValue(o.model, o.effort);
          const selected = value === currentValue;
          return (
            <DropdownMenuItem
              key={value}
              onSelect={() => {
                if (selected) return;
                const { model: m, effort: ef } = parseComboValue(value);
                onSave(m, ef);
              }}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "justify-between",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 truncate">
                {modelEffortLabel(o.model, o.effort)}
              </span>
              {selected ? <DropdownMenuItemIndicator /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SettingsPage() {
  const { data, isLoading } = useSettings();
  const update = useUpdateSettings();
  const [activeTab, setActiveTab] = useState<"agent" | "workflows">("agent");
  const agentTabRef = useRef<HTMLButtonElement>(null);
  const workflowsTabRef = useRef<HTMLButtonElement>(null);
  const devCostLimitUsd = data?.devCostLimitUsd ?? 10;
  const [devCostLimitInput, setDevCostLimitInput] = useState(
    moneyInputValue(devCostLimitUsd),
  );

  useEffect(() => {
    setDevCostLimitInput(moneyInputValue(devCostLimitUsd));
  }, [devCostLimitUsd]);

  const codingAgent = data?.codingAgent ?? "claude-code";
  const workflowContractLanguage = data?.workflowContractLanguage ?? "en";
  const devCostLimitError = validateDevCostLimit(devCostLimitInput);
  const parsedDevCostLimit = Number(devCostLimitInput.trim());
  const devCostLimitChanged =
    !devCostLimitError && parsedDevCostLimit !== devCostLimitUsd;

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextTab = activeTab === "agent" ? "workflows" : "agent";
    setActiveTab(nextTab);
    (nextTab === "agent" ? agentTabRef : workflowsTabRef).current?.focus();
  };

  return (
    <div data-debug-component="SettingsPage" className="mx-auto max-w-content">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Instance-level settings for this LoopHub server.
      </p>

      <div
        role="tablist"
        aria-label="Settings categories"
        className="mt-6 flex h-11 items-end gap-1 border-b"
      >
        <button
          ref={agentTabRef}
          id="settings-agent-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "agent"}
          aria-controls="settings-agent-panel"
          tabIndex={activeTab === "agent" ? 0 : -1}
          className={cn(
            "-mb-px inline-flex h-11 items-center justify-center border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            activeTab === "agent"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
          )}
          onClick={() => setActiveTab("agent")}
          onKeyDown={handleTabKeyDown}
        >
          Agent
        </button>
        <button
          ref={workflowsTabRef}
          id="settings-workflows-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "workflows"}
          aria-controls="settings-workflows-panel"
          tabIndex={activeTab === "workflows" ? 0 : -1}
          className={cn(
            "-mb-px inline-flex h-11 items-center justify-center border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            activeTab === "workflows"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
          )}
          onClick={() => setActiveTab("workflows")}
          onKeyDown={handleTabKeyDown}
        >
          Workflows
        </button>
      </div>

      <div
        id="settings-agent-panel"
        role="tabpanel"
        aria-labelledby="settings-agent-tab"
        hidden={activeTab !== "agent"}
        className="mt-6"
      >
        <section data-debug-component="CodingAgentSettings">
          <h2 className="text-sm font-medium">Coding agent</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Default coding agent for builds.
          </p>
          <div
            role="radiogroup"
            aria-label="Coding agent"
            className="mt-3 max-w-md rounded-md border"
          >
            {CODING_AGENT_OPTIONS.map((o) => {
              const active = codingAgent === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={isLoading || update.isPending}
                  className={cn(
                    "flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground",
                    disabledButtonStateClasses,
                  )}
                  onClick={() => {
                    if (active) return;
                    update.mutate({ codingAgent: o.value });
                  }}
                >
                  <Check
                    className={`mt-0.5 size-4 shrink-0 ${active ? "" : "invisible"}`}
                    aria-hidden="true"
                  />
                  <span>{o.label}</span>
                </button>
              );
            })}
          </div>

          {/* Child settings, one block per agent, indented under the agent
            selection above instead of living in a separate flat section. */}
          <div className="mt-3 max-w-md border-l-2 pl-4">
            {CODING_AGENT_OPTIONS.map((agentOption, i) => {
              const autoModeOnLaunch =
                data?.agents?.[agentOption.value]?.autoModeOnLaunch ?? false;
              const model = data?.agents?.[agentOption.value]?.model ?? "";
              const effort = data?.agents?.[agentOption.value]?.effort ?? "";
              return (
                <div
                  key={agentOption.value}
                  className={i > 0 ? "mt-4" : undefined}
                >
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {agentOption.label} — Auto mode on launch
                  </h3>
                  <div
                    role="radiogroup"
                    aria-label={`Auto mode on launch (${agentOption.label})`}
                    className="mt-1 max-w-sm rounded-md border"
                  >
                    {autoModeOptions().map((o) => {
                      const active = autoModeOnLaunch === o.value;
                      return (
                        <button
                          key={String(o.value)}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={isLoading || update.isPending}
                          className={cn(
                            "flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground",
                            disabledButtonStateClasses,
                          )}
                          onClick={() => {
                            if (active) return;
                            update.mutate({
                              agent: agentOption.value,
                              autoModeOnLaunch: o.value,
                            });
                          }}
                        >
                          <Check
                            className={`mt-0.5 size-4 shrink-0 ${active ? "" : "invisible"}`}
                            aria-hidden="true"
                          />
                          <span>{o.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  <h3 className="mt-4 text-xs font-medium text-muted-foreground">
                    {agentOption.label} — Default model & effort
                  </h3>
                  <div className="mt-1 max-w-sm">
                    <AgentModelEffortDropdown
                      label={agentOption.label}
                      model={model}
                      effort={effort}
                      modelSuggestions={MODEL_SUGGESTIONS[agentOption.value]}
                      effortSuggestions={EFFORT_SUGGESTIONS[agentOption.value]}
                      disabled={isLoading}
                      saving={update.isPending}
                      onSave={(m, ef) =>
                        update.mutate({
                          agent: agentOption.value,
                          model: m,
                          effort: ef,
                        })
                      }
                    />
                  </div>
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
      </div>

      <div
        id="settings-workflows-panel"
        role="tabpanel"
        aria-labelledby="settings-workflows-tab"
        hidden={activeTab !== "workflows"}
        className="mt-6"
      >
        <section
          data-debug-component="WorkflowContractLanguageSettings"
          className="max-w-md"
        >
          <h2 className="text-sm font-medium">Workflow contract language</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Language for LoopHub&apos;s fixed Parent, Execute, and Verify
            instructions. New runs keep the language selected when they start.
          </p>
          <div
            role="radiogroup"
            aria-label="Workflow contract language"
            className="mt-3 rounded-md border"
          >
            {[
              { value: "en" as const, label: "English" },
              { value: "ja" as const, label: "日本語" },
            ].map((option) => {
              const active = workflowContractLanguage === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={isLoading || update.isPending}
                  className={cn(
                    "flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground",
                    disabledButtonStateClasses,
                  )}
                  onClick={() => {
                    if (active) return;
                    update.mutate({
                      workflowContractLanguage: option.value,
                    });
                  }}
                >
                  <Check
                    className={`mt-0.5 size-4 shrink-0 ${active ? "" : "invisible"}`}
                    aria-hidden="true"
                  />
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section
          data-debug-component="WorkflowSettingsLink"
          className="mt-8 max-w-md"
        >
          <h2 className="text-sm font-medium">Workflows</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create and edit workflows — the Execute/Verify prompt bundles used
            by the development loop.
          </p>
          <Link
            to="/settings/workflows"
            className="mt-3 inline-flex items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Manage workflows
          </Link>
        </section>
      </div>
    </div>
  );
}
