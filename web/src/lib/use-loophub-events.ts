// Polls persisted LoopHub events over JSON-RPC and invalidates the matching
// TanStack Query keys (event-keys.ts) so views refetch on change.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listEvents } from "@/api/client";
import type { LoopEvent } from "@/api/types";
import { queryKeys, queryKeysForEvent } from "@/lib/event-keys";
import { getLastEventId, rememberEventId, setLastEventId } from "@/lib/session";

const VISIBLE_POLL_MS = 1500;
const HIDDEN_POLL_MS = 5000;
const POLL_LIMIT = 100;
const ROLLBACK_PROBE_MS = 30_000;

function applyLoopHubEvent(
  event: LoopEvent,
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  if (!event || typeof event.id !== "number") {
    return;
  }
  rememberEventId(event.id);
  for (const queryKey of queryKeysForEvent(event)) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

function invalidateReconnectQueries(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  const queryKeyPrefixes: readonly (readonly unknown[])[] = [
    queryKeys.repos(),
    ["repo"],
    ["issues"],
    ["issue"],
    ["pulls"],
    ["pull"],
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
    let cursor = getLastEventId();
    let rollbackProbeCursor: number | null = null;
    let rollbackProbeAt = 0;

    const nextDelay = () =>
      document.visibilityState === "hidden" ? HIDDEN_POLL_MS : VISIBLE_POLL_MS;

    const schedule = (delay = nextDelay()) => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, delay);
    };

    const poll = async () => {
      try {
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
          for (const event of events) {
            applyLoopHubEvent(event, queryClient);
            cursor = Math.max(cursor, event.id);
          }
          if (events.length >= POLL_LIMIT) schedule(0);
        }
        if (!stopped && events.length < POLL_LIMIT) schedule();
      } catch {
        if (!stopped) schedule();
      }
    };

    const onVisibilityChange = () => {
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
