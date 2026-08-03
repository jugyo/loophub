import { CODING_AGENT_LABELS } from "@/lib/agent-models";
import { formatCost, formatTokenCountShort } from "@/lib/session-usage";
import { useCurrentRepo } from "@/lib/use-current-repo";
import { useRepoAgentConfig } from "@/queries/repos";
import { useAgentCostSummary } from "@/queries/sessions";
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
  const { data: costSummary } = useAgentCostSummary();
  const unavailableValue = isError ? "Unavailable" : "Loading…";

  // On a repo-scoped route, Agent / Model / Effort follow the repo's resolved Coding agent
  // config (#1536): override fields win when set, otherwise the API already falls back to the
  // application defaults in `effective`. TPS and Cost limit stay instance-wide.
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
  const tokensPer5Minutes = tokenRateHistory(costSummary);
  const tokensPerSecond = currentTokenRate(costSummary);
  const cacheReadTokensPerSecond = currentCacheReadTokenRate(costSummary);

  return (
    <footer
      data-debug-component="AppStatusbar"
      aria-label="Application status"
      className="flex h-7 shrink-0 items-center border-t bg-card px-3"
    >
      <dl className="ml-auto flex items-center justify-end gap-3 text-right text-[11px] leading-none">
        <TokenRateStatus
          tokensPerSecond={tokensPerSecond}
          cacheReadTokensPerSecond={cacheReadTokensPerSecond}
          values={tokensPer5Minutes}
        />
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

function currentCacheReadTokenRate(
  summary: Array<{ cache_read_tokens_per_second?: number | null }> | undefined,
): number | null {
  const rate = summary?.find(
    (row) => "cache_read_tokens_per_second" in row,
  )?.cache_read_tokens_per_second;
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0
    ? rate
    : null;
}

function currentTokenRate(
  summary: Array<{ tokens_per_second?: number | null }> | undefined,
): number | null {
  const rate = summary?.find(
    (row) => "tokens_per_second" in row,
  )?.tokens_per_second;
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0
    ? rate
    : null;
}

function tokenRateHistory(
  summary: Array<{ tokens_per_5m_history?: number[] }> | undefined,
): number[] | null {
  const history = summary?.find(
    (row) => row.tokens_per_5m_history,
  )?.tokens_per_5m_history;
  if (!history) return null;
  return history.map((value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0,
  );
}

function TokenRateStatus({
  tokensPerSecond,
  cacheReadTokensPerSecond,
  values,
}: {
  tokensPerSecond: number | null;
  cacheReadTokensPerSecond: number | null;
  values: number[] | null;
}) {
  const formatted =
    tokensPerSecond == null ? "n/a" : formatTokenCountShort(tokensPerSecond);
  const cacheFormatted =
    cacheReadTokensPerSecond == null
      ? "n/a"
      : formatTokenCountShort(cacheReadTokensPerSecond);
  return (
    <div
      className="flex items-center gap-1"
      title={
        tokensPerSecond == null && cacheReadTokensPerSecond == null
          ? "Token throughput unavailable"
          : "Aggregate token throughput"
      }
    >
      <dt className="text-muted-foreground">TPS</dt>
      <dd
        className="flex items-center gap-1"
        aria-label={`TPS: ${formatted} tokens per second`}
      >
        <span className="font-mono font-medium text-foreground">
          {formatted}
        </span>
        <span className="text-muted-foreground" aria-hidden="true">
          /
        </span>
        <span className="text-muted-foreground">cache</span>
        <span
          className="font-mono font-medium text-foreground"
          aria-label={`Cache TPS: ${cacheFormatted} tokens per second`}
        >
          {cacheFormatted}
        </span>
        {values && <TokenHistoryBars values={values} />}
      </dd>
    </div>
  );
}

function TokenHistoryBars({ values }: { values: number[] }) {
  const max = Math.max(...values, 0);
  return (
    <span
      className="ml-0.5 flex h-4 w-16 items-end gap-px"
      role="img"
      aria-label={`${values.length} token throughput buckets, oldest to newest`}
    >
      {values.map((value, index) => (
        <span
          // Bucket order is meaningful and fixed, so the index is its stable identity.
          key={index}
          className="min-w-0 flex-1 rounded-sm bg-primary/70"
          data-token-count={value}
          style={{
            height: max === 0 ? "0%" : `${(value / max) * 100}%`,
            minHeight: value > 0 ? "2px" : undefined,
          }}
          aria-hidden="true"
        />
      ))}
    </span>
  );
}
