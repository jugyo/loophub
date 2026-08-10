// Polls persisted LoopHub events over JSON-RPC and invalidates the matching
// TanStack Query keys (event-keys.ts) so views refetch on change.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listEvents } from "@/api/client";
import type { LoopEvent } from "@/api/types";
import { recordEvents, recordInvalidation } from "@/lib/debug-log";
import { queryKeys, queryKeysForEvent } from "@/lib/event-keys";
import { getLastEventId, rememberEventId, setLastEventId } from "@/lib/session";

const VISIBLE_POLL_MS = 1500;
// A hidden tab keeps polling so its views are already current when it is brought back, but at a
// slower rate: the freshness it needs is "not stale on return", not "live to the second".
const HIDDEN_POLL_MS = 10_000;
const POLL_LIMIT = 100;
const ROLLBACK_PROBE_MS = 30_000;

// One poll can carry up to POLL_LIMIT events, and most of them invalidate the same repo-scoped
// prefixes. invalidateQueries cancels an in-flight refetch and starts a new one, so invalidating
// per event turned a batch of N events into N RPC calls for a single query. Collect the batch's
// distinct keys first and invalidate each once.
function applyLoopHubEvents(
  events: readonly LoopEvent[],
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  const queryKeys = new Map<string, readonly unknown[]>();
  for (const event of events) {
    if (!event || typeof event.id !== "number") {
      continue;
    }
    rememberEventId(event.id);
    const keys = queryKeysForEvent(event);
    recordInvalidation(event, keys);
    for (const queryKey of keys) {
      queryKeys.set(JSON.stringify(queryKey), queryKey);
    }
  }
  if (events.length > 0) recordEvents(events);
  for (const queryKey of queryKeys.values()) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

function invalidateReconnectQueries(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  const queryKeyPrefixes: readonly (readonly unknown[])[] = [
    queryKeys.repos(),
    ["repo"],
    ["repo-merge-mode"],
    ["repo-agent-config"],
    ["issues"],
    ["issue"],
    ["issue-comments"],
    ["pulls"],
    ["pull"],
    ["pull-debug"],
    ["pull-files"],
    ["pull-reviews"],
    ["pull-review-comments"],
    ["github-pr-status"],
    queryKeys.agentSessions(),
    queryKeys.terminalSessions(),
    queryKeys.events(),
    queryKeys.dashboard(),
    ["settings"],
    ["terminal", "config"],
  ];

  for (const queryKey of queryKeyPrefixes) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

async function resetCursorIfServerRolledBack(
  cursor: number,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<number> {
  if (cursor <= 0) return cursor;
  const newest = await listEvents({ since: 0, order: "desc", limit: 1 });
  const newestId = newest[0]?.id ?? 0;
  if (newestId >= cursor) return cursor;
  setLastEventId(newestId);
  invalidateReconnectQueries(queryClient);
  return newestId;
}

/**
 * Poll events/list and invalidate queries on each event. Mount once near the app root.
 */
export function useLoopHubEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollInFlight = false;
    let cursor = getLastEventId();
    let rollbackProbeCursor: number | null = null;
    let rollbackProbeAt = 0;

    const pollDelay = () =>
      document.visibilityState === "visible" ? VISIBLE_POLL_MS : HIDDEN_POLL_MS;

    const schedule = (delay = pollDelay()) => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, delay);
    };

    const poll = async () => {
      if (stopped || pollInFlight) {
        return;
      }
      pollInFlight = true;
      try {
        if (cursor === 0) {
          // No stored cursor means this client has never seen an event, not that it is behind by
          // the whole history. Replaying from id 0 pages through every event ever recorded — on a
          // long-lived instance that is thousands of back-to-back polls, each invalidating the
          // same keys again. The mounted queries already fetched current state, so start at the
          // newest id and only follow what happens from here.
          const newest = await listEvents({
            since: 0,
            order: "desc",
            limit: 1,
          });
          if (stopped) return;
          cursor = newest[0]?.id ?? 0;
          setLastEventId(cursor);
          schedule();
          return;
        }
        const events = await listEvents({ since: cursor, limit: POLL_LIMIT });
        if (stopped) return;
        if (events.length === 0) {
          const now = Date.now();
          if (
            cursor !== rollbackProbeCursor ||
            now - rollbackProbeAt >= ROLLBACK_PROBE_MS
          ) {
            rollbackProbeCursor = cursor;
            rollbackProbeAt = now;
            cursor = await resetCursorIfServerRolledBack(cursor, queryClient);
          }
        } else {
          applyLoopHubEvents(events, queryClient);
          for (const event of events) {
            cursor = Math.max(cursor, event.id);
          }
          if (events.length >= POLL_LIMIT) schedule(0);
        }
        if (!stopped && events.length < POLL_LIMIT) schedule();
      } catch {
        if (!stopped) schedule();
      } finally {
        pollInFlight = false;
      }
    };

    // Visibility only switches the polling rate. Becoming visible polls right away instead of
    // waiting out the slow interval; becoming hidden re-times the pending poll to the slow one.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      schedule();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer) clearTimeout(timer);
    };
  }, [queryClient]);
}
