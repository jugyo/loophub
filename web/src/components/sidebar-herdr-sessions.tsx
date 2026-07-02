// Sidebar section (#495): running herdr sessions grouped by repo, shown under the
// repository list. Display-only — each agent row is a name (e.g. "dev #486") plus a
// status dot. Renders nothing while loading, on error, or when no session has agents,
// so the section never gets in the way when herdr isn't in use.
//
// Hovering a row (#500) shows a preview of that agent's recent terminal output,
// fetched on demand via `terminal/agentRead`.
import { useEffect, useRef, useState } from "react";
import type { HerdrAgent } from "@/api/types";
import { cn } from "@/lib/utils";
import { useHerdrAgentRead, useHerdrSessions } from "@/queries/terminal";

// Hover must hold this long before a preview fetch fires — avoids spawning a herdr
// process for every row the pointer passes over on its way elsewhere (#500 AC: don't
// hammer herdr on every hover). useHerdrAgentRead's staleTime then covers repeat
// hovers shortly after.
const HOVER_DEBOUNCE_MS = 300;

// `herdr agent read` accepts a pane id or a *unique* agent name — two label-less
// launches can share a display name (see HerdrAgent.id's doc in api/types.ts), which
// would make a name-based lookup ambiguous. `agent.id` is already the pane id
// whenever herdr reported one (core/herdr-status.ts's parseHerdrAgentList); prefer it
// so the preview can't be misattributed to another same-named agent, falling back to
// the name only for the rare synthetic id (`\u0000idx:N`, no pane_id case).
function agentReadTarget(agent: HerdrAgent): string {
  return agent.id.startsWith("\u0000idx:") ? agent.name : agent.id;
}

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
            <AgentRow key={agent.id} repo={group.repo} agent={agent} />
          ))}
        </div>
      ))}
    </div>
  );
}

function AgentRow({ repo, agent }: { repo: string; agent: HerdrAgent }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preview, setPreview] = useState<{ top: number; left: number } | null>(
    null,
  );

  function clearHoverTimer() {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  // Guards against a debounced fetch firing (and calling setState) after the row has
  // already unmounted, e.g. the sidebar list refreshing mid-hover.
  useEffect(() => {
    return () => clearHoverTimer();
  }, []);

  function onMouseEnter() {
    clearHoverTimer();
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPreview({
        // Clamp so the panel stays on screen: pulled up for rows near the sidebar
        // bottom, but never above the viewport top on short windows.
        top: Math.max(
          0,
          Math.min(rect.top, window.innerHeight - AGENT_PREVIEW_MAX_HEIGHT - 8),
        ),
        // Same idea horizontally: pulled left on narrow viewports so the panel
        // (w-96, capped at 60vw) doesn't run off the right edge.
        left: Math.max(
          8,
          Math.min(rect.right + 8, window.innerWidth - AGENT_PREVIEW_WIDTH - 8),
        ),
      });
    }, HOVER_DEBOUNCE_MS);
  }

  function onMouseLeave() {
    clearHoverTimer();
    setPreview(null);
  }

  return (
    <div
      ref={rowRef}
      className="flex items-center gap-2 px-2 py-0.5 pl-4 text-sm"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
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
      {preview ? (
        <AgentPreview
          repo={repo}
          target={agentReadTarget(agent)}
          position={preview}
        />
      ) : null}
    </div>
  );
}

const AGENT_PREVIEW_MAX_HEIGHT = 256;
const AGENT_PREVIEW_WIDTH = 384; // matches the panel's w-96

// Positioned with `fixed` (not `absolute` in the row's own flow) so it isn't clipped by
// the sidebar's scrollable, overflow-hidden ancestor (the `overflow-y-auto` div in
// app-sidebar.tsx that wraps the repo list and this section).
function AgentPreview({
  repo,
  target,
  position,
}: {
  repo: string;
  target: string;
  position: { top: number; left: number };
}) {
  // enabled: true here is safe — the row only mounts this once the hover debounce (see
  // HOVER_DEBOUNCE_MS above) has already elapsed; staleTime on the hook covers reuse.
  const { data, isLoading } = useHerdrAgentRead(repo, target, {
    enabled: true,
  });
  if (isLoading || !data?.output) return null;

  return (
    <div
      role="tooltip"
      className="fixed z-50 w-96 max-w-[60vw] overflow-y-auto rounded-md border bg-background p-2 shadow-lg"
      style={{
        top: position.top,
        left: position.left,
        maxHeight: AGENT_PREVIEW_MAX_HEIGHT,
      }}
    >
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
        {data.output}
      </pre>
    </div>
  );
}
