// Instance-level settings (#474) — the first entry point for global config.json settings, as
// opposed to the per-repo settings menu (see repo-menu.tsx's MergeModeSection).

import { Check } from "lucide-react";
import type { TerminalLaunchBackend } from "@/api/types";
import { useSettings, useUpdateSettings } from "@/queries/settings";

const BACKEND_OPTIONS: {
  value: TerminalLaunchBackend;
  label: string;
  hint: string;
}[] = [
  {
    value: "builtin",
    label: "Builtin",
    hint: "Terminal workflows run in the embedded PTY pane.",
  },
  {
    value: "herdr",
    label: "Herdr",
    hint: "Terminal workflows launch as external Herdr sessions.",
  },
];

export function SettingsPage() {
  const { data, isLoading } = useSettings();
  const update = useUpdateSettings();

  const current = data?.terminalLaunchBackend ?? "builtin";

  return (
    <div className="mx-auto max-w-content">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Instance-level settings for this LoopHub server.
      </p>

      <section className="mt-6">
        <h2 className="text-sm font-medium">Terminal launch backend</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          How terminal workflows (issue-dev, resume, etc.) are launched.
        </p>
        <div
          role="radiogroup"
          aria-label="Terminal launch backend"
          className="mt-3 max-w-md rounded-md border"
        >
          {BACKEND_OPTIONS.map((o) => {
            const active = current === o.value;
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
                  update.mutate({ terminalLaunchBackend: o.value });
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
        {update.error ? (
          <p className="mt-2 text-sm text-destructive">
            {String(update.error)}
          </p>
        ) : null}
      </section>
    </div>
  );
}
