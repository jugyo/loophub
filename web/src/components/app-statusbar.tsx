import { CODING_AGENT_LABELS } from "@/lib/agent-models";
import { formatCost } from "@/lib/session-usage";
import { useSettings } from "@/queries/settings";

function configuredValue(value: string | undefined): string {
  return value?.trim() ? value : "Not set";
}

export function AppStatusbar() {
  const { data, isError } = useSettings();
  const unavailableValue = isError ? "Unavailable" : "Loading…";
  const agent = data?.codingAgent;
  const agentSettings = agent ? data.agents[agent] : undefined;

  const items = [
    {
      label: "Agent",
      value: agent ? CODING_AGENT_LABELS[agent] : unavailableValue,
    },
    {
      label: "Model",
      value: data ? configuredValue(agentSettings?.model) : unavailableValue,
    },
    {
      label: "Effort",
      value: data ? configuredValue(agentSettings?.effort) : unavailableValue,
    },
    {
      label: "Cost limit / session",
      value: data ? formatCost(data.devCostLimitUsd) : unavailableValue,
    },
  ];

  return (
    <footer
      aria-label="Application status"
      className="flex h-8 shrink-0 items-center border-t bg-card px-4"
    >
      <dl className="ml-auto flex items-center justify-end gap-5 text-right text-xs">
        {items.map((item) => (
          <div key={item.label} className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd className="font-medium text-foreground">{item.value}</dd>
          </div>
        ))}
      </dl>
    </footer>
  );
}
