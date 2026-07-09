import { Link } from "@tanstack/react-router";
import { BarChart3, CalendarRange, Loader2, Rows3 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type {
  AgentSession,
  SessionLinkedTarget,
  SessionSubagentUsage,
  SessionUsage,
} from "@/api/types";
import { Badge } from "@/components/ui/badge";
import {
  formatCost,
  formatTokenCount,
  modelLabel,
  totalTokens,
  usageCost,
  usageTotal,
} from "@/lib/session-usage";
import { relativeTime } from "@/lib/time";
import { useAgentSessions } from "@/queries/sessions";

export { formatCost, formatTokenCount } from "@/lib/session-usage";

type RangePreset = {
  id: "week" | "month" | "quarter";
  label: string;
  days: number;
};

type Granularity = "day" | "week" | "month";
type ChartMode = "total" | "agent";

type CostTotal = {
  cost: number;
  hasUnknownCost: boolean;
};

type AgentCost = {
  key: string;
  label: string;
  cost: CostTotal;
  sessions: number;
};

type CostBucket = {
  key: string;
  label: string;
  start: Date;
  end: Date;
  total: CostTotal;
  agents: AgentCost[];
};

const RANGE_PRESETS: RangePreset[] = [
  { id: "week", label: "last 1 week", days: 7 },
  { id: "month", label: "last 1 month", days: 30 },
  { id: "quarter", label: "last 3 months", days: 90 },
];

const GRANULARITIES: Array<{ id: Granularity; label: string }> = [
  { id: "day", label: "Daily" },
  { id: "week", label: "Weekly" },
  { id: "month", label: "Monthly" },
];

const CHART_MODES: Array<{ id: ChartMode; label: string }> = [
  { id: "total", label: "Total" },
  { id: "agent", label: "By agent" },
];

const RUNTIME_CLAUDE_CODE = "claude-code";
const RUNTIME_CODEX = "codex";
const AGENT_COLORS = [
  "bg-emerald-500",
  "bg-sky-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-violet-500",
  "bg-slate-500",
];

function targetHref(target: SessionLinkedTarget): string {
  const [owner, repo] = target.repo.split("/");
  return `/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${target.kind === "pull" ? "pulls" : "issues"}/${target.number}`;
}

function targetLabel(target: SessionLinkedTarget): string {
  return `${target.kind === "pull" ? "PR" : "Issue"} #${target.number}`;
}

function updatedTime(session: AgentSession): number {
  const ms = Date.parse(session.updated_at);
  return Number.isFinite(ms) ? ms : 0;
}

function createdTime(session: AgentSession): number {
  const ms = Date.parse(session.created_at);
  return Number.isFinite(ms) ? ms : 0;
}

function zeroCost(): CostTotal {
  return { cost: 0, hasUnknownCost: false };
}

function addCost(total: CostTotal, next: CostTotal): CostTotal {
  return {
    cost: total.cost + next.cost,
    hasUnknownCost: total.hasUnknownCost || next.hasUnknownCost,
  };
}

function formatCostTotal(total: CostTotal): string {
  return total.hasUnknownCost ? "n/a" : formatCost(total.cost);
}

function usageCostTotal(usage: SessionUsage[] | undefined): CostTotal {
  return (usage ?? []).reduce<CostTotal>((total, row) => {
    if (row.cost_usd === null || !Number.isFinite(row.cost_usd)) {
      total.hasUnknownCost = true;
      return total;
    }
    total.cost += row.cost_usd;
    return total;
  }, zeroCost());
}

function sessionCost(session: AgentSession): CostTotal {
  return usageCostTotal(session.usage);
}

function effectiveRuntime(session: AgentSession): string | null {
  if (session.runtime) return session.runtime;
  if (session.agent === "lh-build" || session.agent === "lh-dev")
    return RUNTIME_CLAUDE_CODE;
  return null;
}

function agentKey(session: AgentSession): string {
  return effectiveRuntime(session) ?? session.agent ?? "unknown";
}

function agentLabel(key: string): string {
  if (key === RUNTIME_CLAUDE_CODE) return "Claude Code";
  if (key === RUNTIME_CODEX) return "Codex";
  return key;
}

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function startOfUtcWeek(date: Date): Date {
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addDays(startOfUtcDay(date), mondayOffset);
}

function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date: Date, months: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
}

function rangeBounds(preset: RangePreset, now: Date) {
  const end = addDays(startOfUtcDay(now), 1);
  return { start: addDays(end, -preset.days), end };
}

function bucketStart(date: Date, granularity: Granularity): Date {
  if (granularity === "day") return startOfUtcDay(date);
  if (granularity === "week") return startOfUtcWeek(date);
  return startOfUtcMonth(date);
}

function nextBucketStart(date: Date, granularity: Granularity): Date {
  if (granularity === "day") return addDays(date, 1);
  if (granularity === "week") return addDays(date, 7);
  return addMonths(date, 1);
}

function bucketLabel(start: Date, granularity: Granularity): string {
  if (granularity === "month")
    return start.toLocaleDateString(undefined, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  return start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function filterSessions(
  sessions: AgentSession[],
  start: Date,
  end: Date,
): AgentSession[] {
  const startMs = start.getTime();
  const endMs = end.getTime();
  return sessions.filter((session) => {
    const created = createdTime(session);
    return created >= startMs && created < endMs;
  });
}

function groupAgentCosts(sessions: AgentSession[]): AgentCost[] {
  const agents = new Map<string, AgentCost>();
  for (const session of sessions) {
    const key = agentKey(session);
    const existing = agents.get(key) ?? {
      key,
      label: agentLabel(key),
      cost: zeroCost(),
      sessions: 0,
    };
    existing.cost = addCost(existing.cost, sessionCost(session));
    existing.sessions += 1;
    agents.set(key, existing);
  }
  return [...agents.values()].sort((a, b) => b.cost.cost - a.cost.cost);
}

function buildBuckets(
  sessions: AgentSession[],
  start: Date,
  end: Date,
  granularity: Granularity,
): CostBucket[] {
  const buckets: CostBucket[] = [];
  let cursor = bucketStart(start, granularity);
  while (cursor < end) {
    const bucketEnd = nextBucketStart(cursor, granularity);
    const bucketSessions = filterSessions(sessions, cursor, bucketEnd);
    buckets.push({
      key: cursor.toISOString(),
      label: bucketLabel(cursor, granularity),
      start: cursor,
      end: bucketEnd,
      total: bucketSessions.reduce(
        (total, session) => addCost(total, sessionCost(session)),
        zeroCost(),
      ),
      agents: groupAgentCosts(bucketSessions),
    });
    cursor = bucketEnd;
  }
  return buckets;
}

function costSortValue(session: AgentSession): number {
  const cost = sessionCost(session);
  return cost.hasUnknownCost ? -1 : cost.cost;
}

function sortedByCost(sessions: AgentSession[]): AgentSession[] {
  return [...sessions].sort((a, b) => {
    const costDelta = costSortValue(b) - costSortValue(a);
    if (costDelta !== 0) return costDelta;
    return updatedTime(b) - updatedTime(a);
  });
}

export function AgentSessionsPage() {
  const { data, isLoading, isError } = useAgentSessions();
  const [rangeId, setRangeId] = useState<RangePreset["id"]>("month");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [chartMode, setChartMode] = useState<ChartMode>("total");

  const preset =
    RANGE_PRESETS.find((candidate) => candidate.id === rangeId) ??
    RANGE_PRESETS[1];
  const now = new Date(Date.now());
  const bounds = rangeBounds(preset, now);
  const filteredSessions = useMemo(
    () => filterSessions(data ?? [], bounds.start, bounds.end),
    [data, bounds.start, bounds.end],
  );
  const buckets = useMemo(
    () => buildBuckets(filteredSessions, bounds.start, bounds.end, granularity),
    [filteredSessions, bounds.start, bounds.end, granularity],
  );
  const agentCosts = useMemo(
    () => groupAgentCosts(filteredSessions),
    [filteredSessions],
  );
  const totalCost = filteredSessions.reduce(
    (total, session) => addCost(total, sessionCost(session)),
    zeroCost(),
  );

  return (
    <div className="flex w-full flex-col">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Agent sessions</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Coding agent cost over time and session-level usage for the selected
            period.
          </p>
        </div>
      </div>

      {isLoading && (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      )}
      {isError && (
        <div className="mt-6 text-sm text-destructive">
          Failed to load agent sessions.
        </div>
      )}
      {data && data.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">No agent sessions.</p>
      )}
      {data && data.length > 0 && (
        <>
          <Controls
            rangeId={rangeId}
            granularity={granularity}
            chartMode={chartMode}
            onRangeChange={setRangeId}
            onGranularityChange={setGranularity}
            onChartModeChange={setChartMode}
          />
          <Overview
            preset={preset}
            sessions={filteredSessions}
            totalCost={totalCost}
            agentCosts={agentCosts}
          />
          <CostChart
            buckets={buckets}
            agentCosts={agentCosts}
            mode={chartMode}
          />
          <AgentComparison agents={agentCosts} />
          <SessionsTable sessions={filteredSessions} />
        </>
      )}
    </div>
  );
}

function Controls({
  rangeId,
  granularity,
  chartMode,
  onRangeChange,
  onGranularityChange,
  onChartModeChange,
}: {
  rangeId: RangePreset["id"];
  granularity: Granularity;
  chartMode: ChartMode;
  onRangeChange: (value: RangePreset["id"]) => void;
  onGranularityChange: (value: Granularity) => void;
  onChartModeChange: (value: ChartMode) => void;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-4 border-b pb-4">
      <SegmentedControl
        icon={<CalendarRange className="size-4" />}
        label="Range"
        options={RANGE_PRESETS}
        value={rangeId}
        onChange={onRangeChange}
      />
      <SegmentedControl
        icon={<Rows3 className="size-4" />}
        label="Granularity"
        options={GRANULARITIES}
        value={granularity}
        onChange={onGranularityChange}
      />
      <SegmentedControl
        icon={<BarChart3 className="size-4" />}
        label="View"
        options={CHART_MODES}
        value={chartMode}
        onChange={onChartModeChange}
      />
    </div>
  );
}

function SegmentedControl<T extends string>({
  icon,
  label,
  options,
  value,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="flex rounded-md border bg-card p-0.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`h-8 whitespace-nowrap rounded px-2.5 text-sm ${
              value === option.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }`}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Overview({
  preset,
  sessions,
  totalCost,
  agentCosts,
}: {
  preset: RangePreset;
  sessions: AgentSession[];
  totalCost: CostTotal;
  agentCosts: AgentCost[];
}) {
  const topAgent = agentCosts[0];

  return (
    <div className="mt-5 grid grid-cols-4 gap-3">
      <Metric
        label={`${preset.label} cost`}
        value={formatCostTotal(totalCost)}
      />
      <Metric label="Sessions" value={sessions.length.toLocaleString()} />
      <Metric
        label="Coding agents"
        value={agentCosts.length.toLocaleString()}
      />
      <Metric
        label="Top agent"
        value={topAgent ? topAgent.label : "n/a"}
        detail={topAgent ? formatCostTotal(topAgent.cost) : undefined}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {detail ? (
        <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function CostChart({
  buckets,
  agentCosts,
  mode,
}: {
  buckets: CostBucket[];
  agentCosts: AgentCost[];
  mode: ChartMode;
}) {
  const maxCost = Math.max(
    0,
    ...buckets.map((bucket) =>
      mode === "total"
        ? barCostValue(bucket.total)
        : Math.max(
            0,
            ...bucket.agents.map((agent) => barCostValue(agent.cost)),
          ),
    ),
  );
  const colorByAgent = new Map(
    agentCosts.map((agent, index) => [
      agent.key,
      AGENT_COLORS[index % AGENT_COLORS.length],
    ]),
  );

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium">Cost trend</h2>
        {mode === "agent" && agentCosts.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-3 text-xs text-muted-foreground">
            {agentCosts.map((agent) => (
              <span key={agent.key} className="flex items-center gap-1.5">
                <span
                  className={`size-2 rounded-sm ${colorByAgent.get(agent.key)}`}
                />
                {agent.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div
        aria-label={
          mode === "total" ? "Total cost trend" : "Agent cost comparison trend"
        }
        className="mt-3 flex h-[260px] items-end gap-2 overflow-x-auto rounded-md border bg-card p-4"
      >
        {buckets.map((bucket) => (
          <div
            key={bucket.key}
            className="flex h-full min-w-12 flex-1 flex-col justify-end gap-2"
          >
            <div className="flex min-h-0 flex-1 items-end justify-center gap-1">
              {mode === "total" ? (
                <ChartBar
                  label={`${bucket.label}: ${formatCostTotal(bucket.total)}`}
                  height={barHeight(barCostValue(bucket.total), maxCost)}
                  className={
                    bucket.total.hasUnknownCost
                      ? "bg-muted-foreground"
                      : "bg-primary"
                  }
                />
              ) : (
                bucket.agents.map((agent) => (
                  <ChartBar
                    key={agent.key}
                    label={`${bucket.label} ${agent.label}: ${formatCostTotal(agent.cost)}`}
                    height={barHeight(barCostValue(agent.cost), maxCost)}
                    className={
                      agent.cost.hasUnknownCost
                        ? "bg-muted-foreground"
                        : (colorByAgent.get(agent.key) ?? "bg-slate-500")
                    }
                  />
                ))
              )}
            </div>
            <div className="truncate text-center text-xs text-muted-foreground">
              {bucket.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function barHeight(cost: number, maxCost: number): string {
  if (cost <= 0 || maxCost <= 0) return "2px";
  return `${Math.max(6, (cost / maxCost) * 100)}%`;
}

function barCostValue(cost: CostTotal): number {
  return cost.hasUnknownCost ? 0 : cost.cost;
}

function ChartBar({
  label,
  height,
  className,
}: {
  label: string;
  height: string;
  className: string;
}) {
  return (
    <div
      aria-label={label}
      title={label}
      className={`w-full min-w-2 rounded-t ${className}`}
      style={{ height }}
    />
  );
}

function AgentComparison({ agents }: { agents: AgentCost[] }) {
  const maxCost = Math.max(
    0,
    ...agents.map((agent) => barCostValue(agent.cost)),
  );

  return (
    <section className="mt-6">
      <h2 className="text-sm font-medium">Agent comparison</h2>
      {agents.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No sessions in the selected period.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {agents.map((agent) => (
            <div key={agent.key} className="rounded-md border bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">{agent.label}</div>
                <div className="text-right font-medium tabular-nums">
                  {formatCostTotal(agent.cost)}
                </div>
              </div>
              <div className="mt-2 h-2 rounded bg-muted">
                <div
                  className="h-2 rounded bg-primary"
                  style={{
                    width: barHeight(barCostValue(agent.cost), maxCost),
                  }}
                />
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {agent.sessions.toLocaleString()} sessions
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SessionsTable({ sessions }: { sessions: AgentSession[] }) {
  const sortedSessions = sortedByCost(sessions);

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-medium">Sessions in selected period</h2>
        <div className="text-xs text-muted-foreground">Sorted by cost desc</div>
      </div>
      {sortedSessions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No sessions in the selected period.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-[1180px] w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="px-3 py-2 font-medium">Session</th>
                <th className="px-3 py-2 font-medium">Session id</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 text-right font-medium">Input</th>
                <th className="px-3 py-2 text-right font-medium">
                  Cache write
                </th>
                <th className="px-3 py-2 text-right font-medium">Cache read</th>
                <th className="px-3 py-2 text-right font-medium">Output</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Subagents</th>
                <th className="px-3 py-2 font-medium">Linked work</th>
                <th className="px-3 py-2 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {sortedSessions.map((session) => {
                const hasUsage = (session.usage?.length ?? 0) > 0;
                const total = usageTotal(session.usage);
                return (
                  <tr
                    key={session.id}
                    className="border-b align-top last:border-b-0"
                  >
                    <td className="max-w-[220px] px-3 py-2">
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone="agent">
                            {session.kind ?? "session"}
                          </Badge>
                          <span className="break-words font-medium">
                            {session.name ?? session.agent}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span>{session.agent}</span>
                          {session.runtime ? (
                            <code className="rounded bg-muted px-1 py-0.5">
                              {session.runtime}
                            </code>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="max-w-[180px] break-all px-3 py-2 text-xs text-muted-foreground">
                      {session.session ? (
                        <code title={session.session}>{session.session}</code>
                      ) : null}
                    </td>
                    <td className="max-w-[180px] break-words px-3 py-2 text-xs">
                      {modelLabel(session.usage)}
                    </td>
                    <UsageCell value={hasUsage ? total.input_tokens : null} />
                    <UsageCell
                      value={
                        hasUsage ? total.cache_creation_input_tokens : null
                      }
                    />
                    <UsageCell
                      value={hasUsage ? total.cache_read_input_tokens : null}
                    />
                    <UsageCell value={hasUsage ? total.output_tokens : null} />
                    <UsageCell value={hasUsage ? totalTokens(total) : null} />
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCost(usageCost(session.usage))}
                    </td>
                    <td className="max-w-[180px] px-3 py-2 text-xs">
                      <SubagentUsage usage={session.subagent_usage} />
                    </td>
                    <td className="max-w-[240px] px-3 py-2">
                      <LinkedTargets targets={session.linked_targets} />
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                      title={session.updated_at}
                    >
                      {relativeTime(session.updated_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UsageCell({ value }: { value: number | null }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      {value === null ? "n/a" : formatTokenCount(value)}
    </td>
  );
}

function SubagentUsage({
  usage,
}: {
  usage: SessionSubagentUsage[] | undefined;
}) {
  if (!usage || usage.length === 0)
    return <span className="text-muted-foreground">n/a</span>;

  const bySource = new Map<string, SessionSubagentUsage[]>();
  for (const row of usage) {
    const rows = bySource.get(row.source_id) ?? [];
    rows.push(row);
    bySource.set(row.source_id, rows);
  }

  return (
    <div className="flex flex-col gap-1.5">
      {[...bySource.entries()].map(([sourceId, rows]) => {
        const total = usageTotal(rows);
        const label = rows.find((row) => row.label)?.label ?? sourceId;
        return (
          <div key={sourceId} className="min-w-0" title={sourceId}>
            <div className="truncate font-medium">{label}</div>
            <div className="text-muted-foreground">
              in {formatTokenCount(total.input_tokens)} · cw{" "}
              {formatTokenCount(total.cache_creation_input_tokens)} · cr{" "}
              {formatTokenCount(total.cache_read_input_tokens)} · out{" "}
              {formatTokenCount(total.output_tokens)}
            </div>
            <div className="text-muted-foreground">
              {formatTokenCount(totalTokens(total))} ·{" "}
              {formatCost(usageCost(rows))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LinkedTargets({
  targets,
}: {
  targets: SessionLinkedTarget[] | undefined;
}) {
  if (!targets || targets.length === 0)
    return <span className="text-muted-foreground">n/a</span>;

  return (
    <div className="flex flex-wrap gap-1.5">
      {targets.map((target) => (
        <Link
          key={`${target.repo}:${target.kind}:${target.number}`}
          to={targetHref(target)}
          title={`${target.repo}: ${target.title}`}
          className="rounded border px-1.5 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground"
        >
          {targetLabel(target)}
        </Link>
      ))}
    </div>
  );
}
