// Sidebar usage summary (#839): a compact Claude Code / Codex spend readout pinned above the
// sidebar footer, showing each agent's current-session and current-week tokens (+ cost) without a
// page navigation. Data comes from the same `sessions/list` payload as the Stats/Sessions page
// (see lib/sidebar-usage.ts), so the numbers reconcile with the saved session usage. Renders a
// stable two-agent layout with n/a placeholders while loading or when an agent has no usage.

import { formatCost, formatTokenCountShort } from "@/lib/session-usage";
import {
  type AgentUsageBucket,
  type AgentUsageSummary,
  summarizeSidebarUsage,
  type UsageAgent,
} from "@/lib/sidebar-usage";
import { useAgentSessions } from "@/queries/sessions";

const AGENT_LABEL: Record<UsageAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function Metric({
  label,
  bucket,
}: {
  label: string;
  bucket: AgentUsageBucket;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        {bucket.hasUsage ? formatTokenCountShort(bucket.tokens) : "n/a"}
        {bucket.hasUsage && bucket.cost !== null ? (
          <span className="ml-1.5 text-muted-foreground">
            {formatCost(bucket.cost)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function AgentUsageRow({ summary }: { summary: AgentUsageSummary }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-xs font-medium">{AGENT_LABEL[summary.agent]}</div>
      <div className="flex flex-col gap-0.5 pl-2 text-[11px]">
        <Metric label="Session" bucket={summary.currentSession} />
        <Metric label="Week" bucket={summary.currentWeek} />
      </div>
    </div>
  );
}

export function SidebarUsageSummary() {
  const { data: sessions } = useAgentSessions();
  const summaries = summarizeSidebarUsage(sessions, Date.now());
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Usage
      </div>
      {summaries.map((s) => (
        <AgentUsageRow key={s.agent} summary={s} />
      ))}
    </div>
  );
}
