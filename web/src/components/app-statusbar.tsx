import { CODING_AGENT_LABELS } from "@/lib/agent-models";
import { formatCost } from "@/lib/session-usage";
import { useCurrentRepo } from "@/lib/use-current-repo";
import { useRepoAgentConfig } from "@/queries/repos";
import { useSettings } from "@/queries/settings";

function configuredValue(value: string | undefined): string {
  return value?.trim() ? value : "Not set";
}

export function AppStatusbar() {
  const { data, isError } = useSettings();
  const currentRepo = useCurrentRepo();
  const [owner = "", repo = ""] = currentRepo?.split("/") ?? [];
  const onRepoPage = Boolean(owner && repo);
  const { data: repoAgentConfig, isError: isRepoAgentError } =
    useRepoAgentConfig(owner, repo, onRepoPage);
  const unavailableValue = isError ? "Unavailable" : "Loading…";

  // On a repo-scoped route, Agent / Model / Effort follow the repo's resolved Coding agent
  // config (#1536): override fields win when set, otherwise the API already falls back to the
  // application defaults in `effective`. Cost limit stays instance-wide.
  let agentValue: string;
  let modelValue: string;
  let effortValue: string;
  if (onRepoPage) {
    if (repoAgentConfig) {
      const { runtime, model, effort } = repoAgentConfig.effective;
      agentValue = CODING_AGENT_LABELS[runtime];
      modelValue = configuredValue(model);
      effortValue = configuredValue(effort);
    } else if (isRepoAgentError) {
      agentValue = "Unavailable";
      modelValue = "Unavailable";
      effortValue = "Unavailable";
    } else {
      agentValue = "Loading…";
      modelValue = "Loading…";
      effortValue = "Loading…";
    }
  } else {
    const agent = data?.codingAgent;
    const agentSettings = agent ? data.agents[agent] : undefined;
    agentValue = agent ? CODING_AGENT_LABELS[agent] : unavailableValue;
    modelValue = data
      ? configuredValue(agentSettings?.model)
      : unavailableValue;
    effortValue = data
      ? configuredValue(agentSettings?.effort)
      : unavailableValue;
  }

  const items = [
    {
      label: "Agent",
      value: agentValue,
    },
    {
      label: "Model",
      value: modelValue,
    },
    {
      label: "Effort",
      value: effortValue,
    },
    {
      label: "Cost limit / session",
      value: data ? formatCost(data.devCostLimitUsd) : unavailableValue,
    },
  ];
  return (
    <footer
      data-debug-component="AppStatusbar"
      aria-label="Application status"
      className="flex h-7 shrink-0 items-center border-t bg-card px-3"
    >
      <dl className="ml-auto flex items-center justify-end gap-3 text-right text-[11px] leading-none">
        {items.map((item) => (
          <div key={item.label} className="flex items-baseline gap-1">
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd className="font-medium text-foreground">{item.value}</dd>
          </div>
        ))}
      </dl>
    </footer>
  );
}
