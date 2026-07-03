// Instance-level settings (#474) — the first entry point for global config.json settings, as
// opposed to the per-repo settings screen (see repo-settings-page.tsx's MergeModeSection).

import { Check } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { CodingAgent } from "@/api/types";
import { Button } from "@/components/ui/button";
import { MODEL_SUGGESTIONS } from "@/lib/agent-models";
import { useSettings, useUpdateSettings } from "@/queries/settings";

// The concrete flag `--auto` maps to differs per agent (cli/dev.ts buildClaudeArgs /
// buildCodexArgs), so the "On" hint is agent-specific rather than a fixed string.
const AUTO_MODE_ON_HINT: Record<CodingAgent, string> = {
  "claude-code":
    "Build launches `lh dev` with auto mode (--auto, `--permission-mode auto`).",
  codex:
    "Build launches `lh dev` with auto mode (--auto, `--dangerously-bypass-approvals-and-sandbox`).",
};

function autoModeOptions(
  agent: CodingAgent,
): { value: boolean; label: string; hint: string }[] {
  return [
    {
      value: false,
      label: "Off",
      hint: "Build launches `lh dev` without auto mode.",
    },
    {
      value: true,
      label: "On",
      hint: AUTO_MODE_ON_HINT[agent],
    },
  ];
}

const CODING_AGENT_OPTIONS: {
  value: CodingAgent;
  label: string;
  hint: string;
}[] = [
  {
    value: "claude-code",
    label: "Claude Code",
    hint: "`lh dev` launches the interactive session in Claude Code.",
  },
  {
    value: "codex",
    label: "Codex",
    hint: "`lh dev` launches the interactive session in Codex.",
  },
];

// A single agent's "Default model" input (#594, #610). A native <input list> + <datalist> combobox:
// the browser offers `suggestions` as a picklist, but any other value can still be typed directly —
// no dedicated combobox component exists in this project's UI kit (see web/src/components/ui/), so
// this reuses the plain <select>-adjacent styling already used elsewhere (issue-list.tsx) rather than
// adding one. Local `draft` state so typing doesn't round-trip through the query cache on every
// keystroke; resyncs with the server value on load/refetch via the effect below (mirrors
// repo-settings-page.tsx's RenameSection).
function AgentModelInput({
  label,
  value,
  suggestions,
  disabled,
  saving,
  onSave,
}: {
  label: string;
  value: string;
  suggestions: string[];
  disabled: boolean;
  saving: boolean;
  onSave: (model: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const listId = useId();
  const trimmed = draft.trim();
  const unchanged = trimmed === value;

  return (
    <form
      className="flex max-w-md gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed && !unchanged && !saving) onSave(trimmed);
      }}
    >
      <input
        type="text"
        list={listId}
        aria-label={`Default model (${label})`}
        className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
        value={draft}
        disabled={disabled || saving}
        onChange={(e) => setDraft(e.target.value)}
      />
      <datalist id={listId}>
        {suggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <Button
        type="submit"
        disabled={disabled || saving || !trimmed || unchanged}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
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
          Which coding agent <code>lh dev</code> launches by default when
          neither --claude-code nor --codex is passed. Each agent's individual
          settings are nested below it.
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
                <span className="flex flex-col">
                  <span>{o.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {o.hint}
                  </span>
                </span>
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
            return (
              <div
                key={agentOption.value}
                className={i > 0 ? "mt-4" : undefined}
              >
                <h3 className="text-xs font-medium text-muted-foreground">
                  {agentOption.label} — Auto mode on Build
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Whether the Build button (issue list / issue detail) launches{" "}
                  <code>lh dev</code> with auto mode for {agentOption.label}.
                </p>
                <div
                  role="radiogroup"
                  aria-label={`Auto mode on Build (${agentOption.label})`}
                  className="mt-2 max-w-sm rounded-md border"
                >
                  {autoModeOptions(agentOption.value).map((o) => {
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
                        <span className="flex flex-col">
                          <span>{o.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {o.hint}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <h3 className="mt-4 text-xs font-medium text-muted-foreground">
                  {agentOption.label} — Default model
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Model {agentOption.label} launches with when{" "}
                  <code>lh dev --model</code> is not passed explicitly. Pick a
                  suggestion or type any model name.
                </p>
                <div className="mt-2 max-w-sm">
                  <AgentModelInput
                    label={agentOption.label}
                    value={model}
                    suggestions={MODEL_SUGGESTIONS[agentOption.value]}
                    disabled={isLoading}
                    saving={update.isPending}
                    onSave={(m) =>
                      update.mutate({ agent: agentOption.value, model: m })
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
