// Subscribes to the LoopHub SSE feed (/events) and invalidates the matching
// TanStack Query keys (event-keys.ts) so views refetch on change.
//
// lh-web emits `event: loophub` frames whose data is a JSON-RPC notification
// ({ jsonrpc, method: "events/notify", params: LoopEvent }). Reconnect resumes
// from the last seen id.
//
// It also emits a separate `event: terminal` frame (#591) when the server-side herdr
// watcher sees the session/agent list change. That frame carries no id/replay semantics
// and no payload — it's a bare "invalidate terminalKeys.sessions and refetch over
// JSON-RPC" signal, not a persisted LoopEvent, so it's handled by its own listener below
// instead of going through queryKeysForEvent.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { eventsUrl } from "@/api/client";
import type { LoopEvent } from "@/api/types";
import { queryKeysForEvent } from "@/lib/event-keys";
import { getLastEventId, rememberEventId } from "@/lib/session";
import { terminalKeys } from "@/queries/terminal";

interface EventNotification {
  jsonrpc: "2.0";
  method: "events/notify";
  params: LoopEvent;
}

/** Build the /events SSE URL, resuming from the last seen event id. */
export function streamUrl(): string {
  const params = new URLSearchParams();
  params.set("since", String(getLastEventId()));
  return eventsUrl(params.toString());
}

/**
 * Open an EventSource to /events and invalidate queries on each event.
 * Mount once near the app root. Reconnects are handled by EventSource itself.
 */
export function useLoopHubEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const es = new EventSource(streamUrl());

    const onMessage = (e: MessageEvent) => {
      let event: LoopEvent;
      try {
        const data = JSON.parse(e.data) as EventNotification | LoopEvent;
        // lh-web wraps each event in a JSON-RPC notification; tolerate a bare event too.
        event = "params" in data ? data.params : (data as LoopEvent);
      } catch {
        return;
      }
      if (!event || typeof event.id !== "number") return;
      rememberEventId(event.id);
      for (const queryKey of queryKeysForEvent(event)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };

    const onTerminal = () => {
      void queryClient.invalidateQueries({ queryKey: terminalKeys.sessions });
    };

    // Server uses a named `loophub` event; listen there and on default messages.
    es.addEventListener("loophub", onMessage as EventListener);
    es.addEventListener("message", onMessage as EventListener);
    es.addEventListener("terminal", onTerminal);

    return () => {
      es.removeEventListener("loophub", onMessage as EventListener);
      es.removeEventListener("message", onMessage as EventListener);
      es.removeEventListener("terminal", onTerminal);
      es.close();
    };
  }, [queryClient]);
}
