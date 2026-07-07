// Instance-level settings (#474) — the first entry point for global config.json settings, as
// opposed to the per-repo settings screen (see repo-settings-page.tsx's MergeModeSection).

import { Check } from "lucide-react";
import type { CodingAgent } from "@/api/types";
import { EFFORT_SUGGESTIONS, MODEL_SUGGESTIONS } from "@/lib/agent-models";
import { useSettings, useUpdateSettings } from "@/queries/settings";

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

const CODING_AGENT_OPTIONS: {
  value: CodingAgent;
  label: string;
}[] = [
  {
    value: "claude-code",
    label: "Claude Code",
  },
  {
    value: "codex",
    label: "Codex",
  },
];

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

// A single agent's "Default model & effort" picker (#594, #610, #682). Was previously a free-text
// <input list>+<datalist> combobox for model alone; replaced with a plain <select> (no dedicated
// combobox component exists in this project's UI kit — see web/src/components/ui/) whose options
// are the full model x effort combination, so a selection always saves a valid pair and an invalid
// combination can never be chosen. If the currently persisted pair isn't one of the combinations
// (e.g. a model saved before effort existed, or a value typed via the old free-text field), it's
// injected as an extra leading option so the picker still reflects the real saved state instead of
// silently jumping to something else (#682 AC: "existing settings select the right combination").
function AgentModelEffortSelect({
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
    <select
      aria-label={`Default model and effort (${label})`}
      className="w-full max-w-md rounded-md border bg-background px-3 py-1.5 text-sm"
      value={currentValue}
      disabled={disabled || saving}
      onChange={(e) => {
        const { model: m, effort: ef } = parseComboValue(e.target.value);
        onSave(m, ef);
      }}
    >
      {options.map((o) => (
        <option
          key={comboValue(o.model, o.effort)}
          value={comboValue(o.model, o.effort)}
        >
          {o.model} — {o.effort}
        </option>
      ))}
    </select>
  );
}

export function SettingsPage() {
  const { data, isLoading } = useSettings();
  const update = useUpdateSettings();

  const codingAgent = data?.codingAgent ?? "claude-code";

  return (
    <div className="mx-auto max-w-content">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Instance-level settings for this LoopHub server.
      </p>

      <section className="mt-6">
        <h2 className="text-sm font-medium">Coding agent</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Default for <code>lh build</code>.
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
                className="flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
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
            const autoModeOnBuild =
              data?.agents?.[agentOption.value]?.autoModeOnBuild ?? false;
            const model = data?.agents?.[agentOption.value]?.model ?? "";
            const effort = data?.agents?.[agentOption.value]?.effort ?? "";
            return (
              <div
                key={agentOption.value}
                className={i > 0 ? "mt-4" : undefined}
              >
                <h3 className="text-xs font-medium text-muted-foreground">
                  {agentOption.label} — Auto mode on Build
                </h3>
                <div
                  role="radiogroup"
                  aria-label={`Auto mode on Build (${agentOption.label})`}
                  className="mt-1 max-w-sm rounded-md border"
                >
                  {autoModeOptions().map((o) => {
                    const active = autoModeOnBuild === o.value;
                    return (
                      <button
                        key={String(o.value)}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={isLoading || update.isPending}
                        className="flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                        onClick={() => {
                          if (active) return;
                          update.mutate({
                            agent: agentOption.value,
                            autoModeOnBuild: o.value,
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
                  <AgentModelEffortSelect
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
    </div>
  );
}
