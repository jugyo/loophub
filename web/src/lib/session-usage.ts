import type { SessionUsage } from "@/api/types";

export function formatTokenCount(n: number): string {
  return n.toLocaleString();
}

export function formatCost(cost: number | null): string {
  if (cost === null || !Number.isFinite(cost)) return "n/a";
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function usageTotal(usage: SessionUsage[] | undefined): SessionUsage {
  return (usage ?? []).reduce<SessionUsage>(
    (total, row) => ({
      session_id: total.session_id,
      model: total.model,
      input_tokens: total.input_tokens + row.input_tokens,
      cache_creation_input_tokens:
        total.cache_creation_input_tokens + row.cache_creation_input_tokens,
      cache_read_input_tokens:
        total.cache_read_input_tokens + row.cache_read_input_tokens,
      output_tokens: total.output_tokens + row.output_tokens,
      cost_usd: null,
      updated_at: total.updated_at,
    }),
    {
      session_id: "",
      model: "total",
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      cost_usd: null,
      updated_at: "",
    },
  );
}

export function usageCost(usage: SessionUsage[] | undefined): number | null {
  if (!usage || usage.length === 0) return null;
  if (usage.some((row) => row.cost_usd === null)) return null;
  return usage.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
}

export function totalTokens(usage: SessionUsage): number {
  return (
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens +
    usage.output_tokens
  );
}

export function modelLabel(usage: SessionUsage[] | undefined): string {
  if (!usage || usage.length === 0) return "n/a";
  return usage.map((u) => u.model).join(", ");
}
