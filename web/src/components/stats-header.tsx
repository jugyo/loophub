import { cn } from "@/lib/utils";

export type StatsTab = "cost" | "db";

const STATS_TABS: { id: StatsTab; label: string }[] = [
  { id: "cost", label: "Agent cost" },
  { id: "db", label: "DB Stats" },
];

// Both tabs stay plain Tab-reachable buttons: activating one navigates to its own route, which
// unmounts this header, so a roving tabindex plus arrow-key handler would only move focus into
// the outgoing instance and drop it on `document.body` after the navigation.
export function StatsHeader({
  activeTab,
  onTabChange,
  panelIds,
}: {
  activeTab: StatsTab;
  onTabChange: (tab: StatsTab) => void;
  panelIds?: Partial<Record<StatsTab, string>>;
}) {
  return (
    <header data-debug-component="StatsHeader">
      <h1 className="text-2xl font-semibold">Stats</h1>

      <div
        role="tablist"
        aria-label="Stats categories"
        className="mt-4 flex h-11 items-end gap-1 border-b"
      >
        {STATS_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`stats-${tab.id}-tab`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={panelIds?.[tab.id]}
            className={cn(
              "-mb-px inline-flex h-11 items-center justify-center border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              activeTab === tab.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </header>
  );
}
