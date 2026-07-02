// Instance-level settings (#474) — the first entry point for global config.json settings, as
// opposed to the per-repo settings screen (see repo-settings-page.tsx's MergeModeSection).

import { Check } from "lucide-react";
import type { CodingAgent } from "@/api/types";
import { useSettings, useUpdateSettings } from "@/queries/settings";

const AUTO_MODE_OPTIONS: { value: boolean; label: string; hint: string }[] = [
  {
    value: false,
    label: "Off",
    hint: "Build launches `lh dev` without auto mode.",
  },
  {
    value: true,
    label: "On",
    hint: "Build launches `lh dev` with auto mode (--auto for Claude Code).",
  },
];

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

export function SettingsPage() {
  const { data, isLoading } = useSettings();
  const update = useUpdateSettings();

  const autoModeOnBuild = data?.autoModeOnBuild ?? false;
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
          neither --claude-code nor --codex is passed.
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
      </section>

      <section className="mt-6">
        <h2 className="text-sm font-medium">Auto mode on Build</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Whether the Build button (issue list / issue detail) launches{" "}
          <code>lh dev</code> with auto mode.
        </p>
        <div
          role="radiogroup"
          aria-label="Auto mode on Build"
          className="mt-3 max-w-md rounded-md border"
        >
          {AUTO_MODE_OPTIONS.map((o) => {
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
                  update.mutate({ autoModeOnBuild: o.value });
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
      </section>
    </div>
  );
}
