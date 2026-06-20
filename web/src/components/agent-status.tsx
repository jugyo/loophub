// Agent working-status line, ported from v1 (src/ui.html agentStatusHtml).
// Shows the agent's free-text status with author + time in the tooltip.

import type { AgentStatus as AgentStatusT } from "@/api/types";
import { agentStatusLabel } from "@/lib/badges";
import { relativeTime } from "@/lib/time";

export function AgentStatusLine({
  status,
  detail = false,
}: {
  status: AgentStatusT | null | undefined;
  detail?: boolean;
}) {
  if (!status?.text) return null;
  const who = agentStatusLabel(status);
  const when = status.updated_at ? ` · ${relativeTime(status.updated_at)}` : "";
  return (
    <div
      className={
        detail
          ? "mt-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
          : "text-xs text-muted-foreground"
      }
      title={`@${who}${when}`}
    >
      {status.text}
    </div>
  );
}
