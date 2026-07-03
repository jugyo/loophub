// Sidebar section (#495): running herdr sessions grouped by repo, shown under the
// repository list. Each agent row is a name (e.g. "dev #486"), a robot icon, colored status
// text, a kill button (#521, experimental) that closes the agent's pane, and — on hover (#500) — a preview of
// that agent's recent terminal output, fetched on demand via `terminal/agentRead`. Rows
// whose worktree PR is merged/closed render muted (#611); so do no-PR "New issue" agents once
// they go idle (#633). The kill button is shown only on those muted rows (#621, #633), where
// closing the no-longer-needed pane is the point. Renders
// nothing while loading, on error, or when no session has agents, so the section never gets
// in the way when herdr isn't in use.
import { AnsiUp } from "ansi_up";
import { Bot, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { HerdrAgent } from "@/api/types";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import {
  useFocusHerdrAgent,
  useHerdrAgentRead,
  useHerdrSessions,
  useKillHerdrAgent,
} from "@/queries/terminal";

// Hover must hold this long before a preview fetch fires — avoids spawning a herdr
// process for every row the pointer passes over on its way elsewhere (#500 AC: don't
// hammer herdr on every hover). useHerdrAgentRead's staleTime then covers repeat
// hovers shortly after.
const HOVER_DEBOUNCE_MS = 300;

// Grace period before actually hiding the preview after the pointer leaves the row
// or the preview itself (#523). The preview is `position: fixed`, offset a few px
// from the row, so the pointer crosses a gap of unrelated page content on its way
// there — closing immediately on mouseleave never lets it arrive. Delaying the close
// (and cancelling it if the pointer lands back on the row or the preview within the
// window) keeps the popup open across that gap without leaving it stuck open forever.
const CLOSE_DELAY_MS = 200;

// The positional-fallback id herdr-status.ts assigns when pane_id is missing starts with a
// NUL byte (core/herdr-status.ts's NO_PANE_ID_PREFIX) followed by "idx:". Built the same way
// here (fromCharCode) so this file carries no raw control byte either.
const NO_PANE_ID_PREFIX = `${String.fromCharCode(0)}idx:`;

// `herdr agent read` accepts a pane id or a *unique* agent name — two label-less
// launches can share a display name (see HerdrAgent.id's doc in api/types.ts), which
// would make a name-based lookup ambiguous. `agent.id` is already the pane id
// whenever herdr reported one (core/herdr-status.ts's parseHerdrAgentList); prefer it
// so the preview can't be misattributed to another same-named agent, falling back to
// the name only for the rare synthetic id (no pane_id case).
function agentReadTarget(agent: HerdrAgent): string {
  return agent.id.startsWith(NO_PANE_ID_PREFIX) ? agent.name : agent.id;
}

// Known agent_status values -> text color, matched to herdr's own status colors
// (herdr README "agent awareness": 🔴 blocked, 🟡 working, 🔵 done, 🟢 idle — #528).
// Anything unrecognized falls back to muted.
function statusTextClass(status: string): string {
  switch (status) {
    case "blocked":
      return "text-red-500";
    case "working":
      return "text-yellow-500";
    case "done":
      return "text-blue-500";
    case "idle":
      return "text-green-500";
    default:
      return "text-muted-foreground";
  }
}

function isStaleAgent(agent: HerdrAgent): boolean {
  return (
    agent.pull_closed === true ||
    (agent.pull == null && agent.status === "idle")
  );
}

// Order agents within a repo group so no-longer-needed ones sink to the bottom (#620,
// #645): stale rows (worktree PR merged/closed, or no-PR New issue agents that went
// idle) go after active ones, keeping attention on the top. Reordering stays inside
// the group (the input is one group's agents) and is stable — Array.prototype.sort is
// stable on Node's V8, and the comparator only separates stale from active, so both
// partitions keep their original relative order. Returns a new array; the source
// (react-query cache) is untouched.
export function sortAgents(agents: HerdrAgent[]): HerdrAgent[] {
  return [...agents].sort(
    (a, b) => Number(isStaleAgent(a)) - Number(isStaleAgent(b)),
  );
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
          {sortAgents(group.agents).map((agent) => (
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
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [preview, setPreview] = useState<{
    top: number;
    left: number;
    maxWidth: number;
    maxHeight: number;
  } | null>(null);
  const killAgent = useKillHerdrAgent();
  const focusAgent = useFocusHerdrAgent();
  const { showError } = useToast();
  // Focus switches herdr's focus to this agent's pane (terminal/focusAgent, #578 — the same
  // action as the PR sidebar's Herdr section and the issue-list badge). `agent.id` is the pane
  // id whenever herdr reported one (see agentReadTarget); the synthetic idx: fallback has no
  // real pane to focus, so the button is hidden for it (#617 AC).
  const canFocus = !agent.id.startsWith(NO_PANE_ID_PREFIX);
  // A "finished" row: grayed out so no-longer-needed agents stand out, and given a kill
  // button (#621) that closes the pane immediately (no confirm), since closing finished
  // work is low-risk. Active rows show no kill button at all. Two cases qualify:
  //   1. A PR-linked agent whose worktree PR is merged/closed (`pull_closed`, #611).
  //   2. A "New issue" agent with no linked PR (`pull == null`) that has gone idle (#633):
  //      pull_closed can never be true for it, so idle is the signal its work is done. A
  //      no-PR agent still working/blocked/done stays a normal, active row.
  const stale = isStaleAgent(agent);
  const hasRowActions = canFocus || stale;

  function clearHoverTimer() {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  function clearCloseTimer() {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }

  // Guards against a debounced fetch firing (and calling setState) after the row has
  // already unmounted, e.g. the sidebar list refreshing mid-hover.
  useEffect(() => {
    return () => {
      clearHoverTimer();
      clearCloseTimer();
    };
  }, []);

  function onMouseEnter() {
    clearHoverTimer();
    clearCloseTimer();
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect) return;
      // Viewport-relative, not a fixed pixel cap (#536) — see AGENT_PREVIEW_MAX_WIDTH_VW.
      const maxWidth = window.innerWidth * AGENT_PREVIEW_MAX_WIDTH_VW;
      const maxHeight = window.innerHeight * AGENT_PREVIEW_MAX_HEIGHT_VH;
      setPreview({
        // Clamp so the panel stays on screen: pulled up for rows near the sidebar
        // bottom, but never above the viewport top on short windows. Sized against
        // maxWidth/maxHeight (the largest box previewBoxSize can produce for this
        // viewport, not the smaller fixed fallback size) — this runs before the pane's
        // cols/rows are known (#531), so it must assume the worst case or a sized-up
        // preview near the edge would render off-screen.
        top: Math.max(
          0,
          Math.min(rect.top, window.innerHeight - maxHeight - 8),
        ),
        // Same idea horizontally: pulled left on narrow viewports so the panel doesn't
        // run off the right edge.
        left: Math.max(
          8,
          Math.min(rect.right + 8, window.innerWidth - maxWidth - 8),
        ),
        maxWidth,
        maxHeight,
      });
    }, HOVER_DEBOUNCE_MS);
  }

  // Doesn't hide immediately: scheduleClose (below) gives the pointer time to land on
  // the preview itself, which cancels this via its own onMouseEnter.
  function onMouseLeave() {
    clearHoverTimer();
    scheduleClose();
  }

  function scheduleClose() {
    clearCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setPreview(null);
    }, CLOSE_DELAY_MS);
  }

  // Kills immediately, no confirm (#621): the button only appears on a stale row, so the
  // pane being closed is already finished work. A failure is surfaced via a toast (the
  // confirm dialog that used to carry the error is gone), matching the focus button's
  // error handling above.
  function onKill() {
    killAgent.mutate(
      { repo, paneId: agent.id },
      {
        onError: (e) =>
          showError(
            e instanceof Error ? e.message : "Failed to close the Herdr pane.",
          ),
      },
    );
  }

  return (
    // The preview is a DOM *sibling* of the row, not a child (#523 round 2): mouseenter/
    // mouseleave firing is DOM-ancestry-aware, so nesting the preview inside the row made
    // the browser treat the pointer as never having left the row while it sat over the
    // (visually detached, `position: fixed`) preview — the row's onMouseEnter then failed
    // to re-fire on the way back, and the popup could close while the pointer was still on
    // the row. Siblings have no such ancestry relationship, so enter/leave on each fires
    // purely from real cursor position.
    <>
      <div
        ref={rowRef}
        className="group relative flex w-full items-center gap-2 px-2 py-0.5 pl-4 text-sm"
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <Bot
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className={cn("truncate", stale && "text-muted-foreground")}>
          {agent.name}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 text-xs transition-opacity",
            hasRowActions &&
              "group-hover:opacity-0 group-focus-within:opacity-0",
            // Muted status instead of the status color: a finished PR's agent no longer
            // needs attention, whatever its status says (#611).
            stale
              ? "text-muted-foreground opacity-60"
              : statusTextClass(agent.status),
          )}
        >
          {agent.status}
        </span>
        {hasRowActions ? (
          <div className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {canFocus ? (
              <button
                type="button"
                aria-label={`Focus ${agent.name}'s pane`}
                title="Focus the running Herdr terminal"
                className="pointer-events-auto rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                disabled={focusAgent.isPending}
                onClick={() =>
                  focusAgent.mutate(
                    { repo, paneId: agent.id },
                    {
                      onError: (e) =>
                        showError(
                          e instanceof Error
                            ? e.message
                            : "Failed to focus the Herdr terminal.",
                        ),
                    },
                  )
                }
              >
                <Terminal className="size-3.5" />
              </button>
            ) : null}
            {stale ? (
              <button
                type="button"
                aria-label={`Close ${agent.name}'s pane`}
                title="Close the finished Herdr pane"
                className="pointer-events-auto rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                disabled={killAgent.isPending}
                onClick={onKill}
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {preview ? (
        <AgentPreview
          repo={repo}
          target={agentReadTarget(agent)}
          position={preview}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleClose}
        />
      ) : null}
    </>
  );
}

// Fallback size while the pane's real dimensions are unknown (#531 AC: never silently
// fail, keep the preview visible).
const AGENT_PREVIEW_MAX_HEIGHT = 256;

// Rough monospace line-height metric for the `font-mono text-xs` preview text below — real
// font metrics vary by browser/OS, so this is only a fit, bounded by MIN/MAX so a huge or
// tiny pane can't blow up or shrink the popup unreasonably (#531). The `pre` no longer
// wraps (#548), so there's no equivalent per-character width metric to fit — the popup
// keeps a fixed width and overflowing lines scroll horizontally instead.
const PREVIEW_LINE_HEIGHT_PX = 16;
const PREVIEW_PADDING_PX = 16; // p-2 (8px) top/bottom
const AGENT_PREVIEW_MIN_HEIGHT = 120;

// Upper bound on the sized popup, as a fraction of the viewport rather than a fixed pixel
// value (#536). A fixed cap (previously 640x480) is far smaller than real herdr panes —
// e.g. a common 239x85 pane needs up to ~1376px of height at the metrics above — so the
// popup was silently shrunk back down below the pane's actual content. Height scales with
// this ceiling via the pane's rows; width no longer tracks the pane's columns (#548, the
// `pre` scrolls horizontally instead of wrapping) but now grows all the way to this same
// ceiling too (#553 follow-up) instead of stopping at a fixed 384px, which was narrow
// enough that most panes needed horizontal scrolling just to be readable.
const AGENT_PREVIEW_MAX_WIDTH_VW = 0.6;
const AGENT_PREVIEW_MAX_HEIGHT_VH = 0.7;

// Sizes the popup to the target pane's actual rows (#531) when herdr reported them,
// falling back to the fixed height above when it didn't (herdr down, or the read target is
// the display-name fallback that `pane layout --pane` can't resolve). Width no longer
// tracks the pane's columns (#548) — the `pre` scrolls horizontally instead of wrapping —
// so there's no per-pane signal to size it against; it uses the viewport-relative ceiling
// directly instead (#553 follow-up), matching how height already scales. maxWidth/maxHeight
// are that ceiling, computed once at hover time (see AGENT_PREVIEW_MAX_WIDTH_VW above) so
// the position clamp and the actual box size always agree on the same worst case.
function previewBoxSize(
  rows: number | null,
  maxWidth: number,
  maxHeight: number,
): { width: number; maxHeight: number } {
  if (!rows || rows <= 0) {
    return {
      width: maxWidth,
      maxHeight: Math.min(maxHeight, AGENT_PREVIEW_MAX_HEIGHT),
    };
  }
  return {
    width: maxWidth,
    maxHeight: Math.min(
      maxHeight,
      Math.max(
        AGENT_PREVIEW_MIN_HEIGHT,
        rows * PREVIEW_LINE_HEIGHT_PX + PREVIEW_PADDING_PX,
      ),
    ),
  };
}

// Positioned with `fixed` (not `absolute` in the row's own flow) so it isn't clipped by
// the sidebar's scrollable, overflow-hidden ancestor (the `overflow-y-auto` div in
// app-sidebar.tsx that wraps the repo list and this section).
function AgentPreview({
  repo,
  target,
  position,
  onMouseEnter,
  onMouseLeave,
}: {
  repo: string;
  target: string;
  position: { top: number; left: number; maxWidth: number; maxHeight: number };
  // Keeps the panel open while the pointer is over it, and lets it schedule its own
  // close when the pointer leaves — see CLOSE_DELAY_MS above.
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  // enabled: true here is safe — the row only mounts this once the hover debounce (see
  // HOVER_DEBOUNCE_MS above) has already elapsed; staleTime on the hook covers reuse.
  const { data, isLoading } = useHerdrAgentRead(repo, target, {
    enabled: true,
  });
  // core/herdr-status.ts keeps SGR (color) sequences in `output` (#554) so the terminal's
  // actual colors carry through; ansi_up converts them to inline-styled <span>s here.
  // escape_html defaults to true, so any HTML-special chars in the terminal text itself
  // are entity-escaped before the markup is trusted below — untrusted herdr output can't
  // inject elements through this preview.
  const html = useMemo(() => {
    if (!data?.output) return null;
    return new AnsiUp().ansi_to_html(data.output);
  }, [data?.output]);
  if (isLoading || !data?.output || html === null) return null;
  const { width, maxHeight } = previewBoxSize(
    data.rows ?? null,
    position.maxWidth,
    position.maxHeight,
  );

  return (
    <div
      role="tooltip"
      className="fixed z-50 max-w-[60vw] overflow-x-auto overflow-y-auto rounded-md border bg-background p-2 shadow-lg"
      style={{
        top: position.top,
        left: position.left,
        width,
        maxHeight,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <pre
        className="whitespace-pre font-mono text-xs text-foreground"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
