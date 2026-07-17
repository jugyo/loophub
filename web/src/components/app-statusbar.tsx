import { CODING_AGENT_LABELS } from "@/lib/agent-models";
import { formatCost, formatTokenCountShort } from "@/lib/session-usage";
import { useAgentCostSummary } from "@/queries/sessions";
import { useSettings } from "@/queries/settings";

function configuredValue(value: string | undefined): string {
  return value?.trim() ? value : "Not set";
}

export function AppStatusbar() {
  const { data, isError } = useSettings();
  const { data: costSummary } = useAgentCostSummary();
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
  const tokensPer5Minutes = tokenRateHistory(costSummary);
  const tokensPerSecond = currentTokenRate(costSummary);

  return (
    <footer
      data-debug-component="AppStatusbar"
      aria-label="Application status"
      className="flex h-7 shrink-0 items-center border-t bg-card px-3"
    >
      <dl className="ml-auto flex items-center justify-end gap-3 text-right text-[11px] leading-none">
        <TokenRateStatus
          tokensPerSecond={tokensPerSecond}
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
  values,
}: {
  tokensPerSecond: number | null;
  values: number[] | null;
}) {
  const formatted =
    tokensPerSecond == null ? "n/a" : formatTokenCountShort(tokensPerSecond);
  return (
    <div
      className="flex items-center gap-1"
      title={
        tokensPerSecond == null
          ? "TPS unavailable"
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
