// Sidebar section (#495): running herdr sessions grouped by repo, shown under the
// repository list. Display-only — each agent row is a name (e.g. "dev #486") plus a
// status dot. Renders nothing while loading, on error, or when no session has agents,
// so the section never gets in the way when herdr isn't in use.
import type { HerdrAgent } from "@/api/types";
import { cn } from "@/lib/utils";
import { useHerdrSessions } from "@/queries/terminal";

// Known agent_status values -> dot color; anything unrecognized falls back to muted.
function statusDotClass(status: string): string {
  switch (status) {
    case "working":
      return "bg-green-500";
    case "blocked":
      return "bg-amber-500";
    case "idle":
      return "bg-muted-foreground/50";
    default:
      return "bg-muted-foreground/30";
  }
}

export function SidebarHerdrSessions() {
  const { data, isError } = useHerdrSessions();
  // Hide on error too: react-query keeps the last successful data across a failed
  // refetch, and a stale "working" list is worse than no list while the server is
  // unreachable.
  const groups = (!isError && data?.repos) || [];
  if (groups.length === 0) return null;

  return (
    // Section divider (#514): `border-t` closes off the repo list+Archived block above the
    // same way #504's `border-b`/`border-t` pair closes off the nav and footer — this div is
    // the section's own wrapper (returns null above when there's nothing to show), so the
    // divider only appears alongside the content it separates.
    <div className="mt-3 border-t pt-3">
      <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Agents
      </div>
      {groups.map((group) => (
        <div key={group.repo} className="pb-1">
          <div
            className="truncate px-2 py-0.5 text-xs text-muted-foreground"
            title={group.session_name}
          >
            {group.repo}
          </div>
          {/* Keyed on id, not name: two label-less launches can share a display name. */}
          {group.agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </div>
      ))}
    </div>
  );
}

function AgentRow({ agent }: { agent: HerdrAgent }) {
  return (
    <div className="flex items-center gap-2 px-2 py-0.5 pl-4 text-sm">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          statusDotClass(agent.status),
        )}
        aria-hidden="true"
      />
      <span className="truncate">{agent.name}</span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {agent.status}
      </span>
    </div>
  );
}
