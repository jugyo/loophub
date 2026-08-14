// Instance-level settings (#474) — the first entry point for global config.json settings, as
// opposed to the per-repo settings screen (see repo-settings-page.tsx's MergeModeSection).

import { useEffect, useState } from "react";
import { CodingAgentSettingsList } from "@/components/coding-agent-settings";
import { SettingsLayout } from "@/components/settings-header";
import { Button } from "@/components/ui/button";
import { useSettings, useUpdateSettings } from "@/queries/settings";

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
          <CodingAgentSettingsList
            name="coding-agent"
            label="Coding agent"
            selected={codingAgent}
            values={data?.agents ?? {}}
            disabled={isLoading}
            saving={update.isPending}
            onSelectAgent={(agent) => update.mutate({ codingAgent: agent })}
            onSaveModel={(agent, model, effort) =>
              update.mutate({ agent, model, effort })
            }
          />
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
