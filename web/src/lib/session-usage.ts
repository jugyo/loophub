import type { SessionUsage } from "@/api/types";

export function formatTokenCount(n: number): string {
  return n.toLocaleString();
}

// Compact form for tight spaces (the issue-list PR sub-row, #783) — "1.2k", "3.4M" — as opposed to
// formatTokenCount's full comma-grouped form used on the detail/admin usage tables.
export function formatTokenCountShort(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ];
  for (let i = 0; i < units.length; i++) {
    const [value, suffix] = units[i];
    if (abs < value) continue;
    const scaled = n / value;
    const rounded =
      Math.abs(scaled) >= 100
        ? Math.round(scaled)
        : Math.round(scaled * 10) / 10;
    // Rounding at the top of a bucket can reach 1000 (e.g. 999_500 → 1000k) — that belongs to the
    // next unit up, so fall through to it instead of showing a 4-digit magnitude.
    const next = units[i - 1];
    if (Math.abs(rounded) >= 1000 && next) {
      const nextScaled = n / next[0];
      const nextRounded =
        Math.abs(nextScaled) >= 100
          ? Math.round(nextScaled)
          : Math.round(nextScaled * 10) / 10;
      return `${nextRounded}${next[1]}`;
    }
    return `${rounded}${suffix}`;
  }
  return String(n);
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
