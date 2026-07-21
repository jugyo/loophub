import { type KeyboardEvent, useRef } from "react";
import { cn } from "@/lib/utils";

export type SettingsTab = "agent" | "workflows";

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "workflows", label: "Workflows" },
];

export function SettingsHeader({
  activeTab,
  onTabChange,
  panelIds,
}: {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  panelIds?: Partial<Record<SettingsTab, string>>;
}) {
  const agentTabRef = useRef<HTMLButtonElement>(null);
  const workflowsTabRef = useRef<HTMLButtonElement>(null);
  const tabRefs = {
    agent: agentTabRef,
    workflows: workflowsTabRef,
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextTab = activeTab === "agent" ? "workflows" : "agent";
    onTabChange(nextTab);
    tabRefs[nextTab].current?.focus();
  };

  return (
    <header data-debug-component="SettingsHeader">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Instance-level settings for this LoopHub server.
      </p>

      <div
        role="tablist"
        aria-label="Settings categories"
        className="mt-6 flex h-11 items-end gap-1 border-b"
      >
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            ref={tabRefs[tab.id]}
            id={`settings-${tab.id}-tab`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={panelIds?.[tab.id]}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={cn(
              "-mb-px inline-flex h-11 items-center justify-center border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={handleTabKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </header>
  );
}
