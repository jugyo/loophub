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

import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { eventsUrl } from "@/api/client";
import type { LoopEvent } from "@/api/types";
import {
  recordInvalidLoopHubDebugEvent,
  recordLoopHubDebugEvent,
  recordTerminalDebugEvent,
} from "@/lib/event-debug";
import { queryKeys, queryKeysForEvent } from "@/lib/event-keys";
import { getLastEventId, rememberEventId } from "@/lib/session";
import { terminalKeys } from "@/queries/terminal";

const EVENTS_LOCK_NAME = "loophub-events";
const EVENTS_CHANNEL_NAME = "loophub-events";

interface EventNotification {
  jsonrpc: "2.0";
  method: "events/notify";
  params: LoopEvent;
}

type EventsBroadcast =
  | { type: "loophub"; data: string }
  | { type: "terminal" }
  | { type: "leader-connected" };

/** Build the /events SSE URL, resuming from the last seen event id. */
export function streamUrl(since = getLastEventId()): string {
  const params = new URLSearchParams();
  params.set("since", String(since));
  return eventsUrl(params.toString());
}

export function applyLoopHubEventData(
  dataText: string,
  queryClient: QueryClient,
): void {
  let event: LoopEvent;
  try {
    const data = JSON.parse(dataText) as EventNotification | LoopEvent;
    // lh-web wraps each event in a JSON-RPC notification; tolerate a bare event too.
    event = "params" in data ? data.params : (data as LoopEvent);
  } catch {
    recordInvalidLoopHubDebugEvent(dataText, "invalid JSON");
    return;
  }
  if (!event || typeof event.id !== "number") {
    recordInvalidLoopHubDebugEvent(dataText, "missing numeric event id");
    return;
  }
  recordLoopHubDebugEvent(event, dataText);
  rememberEventId(event.id);
  for (const queryKey of queryKeysForEvent(event)) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

function invalidateTerminalQueries(queryClient: QueryClient): void {
  recordTerminalDebugEvent();
  void queryClient.invalidateQueries({ queryKey: terminalKeys.sessions });
}

function invalidateReconnectQueries(queryClient: QueryClient): void {
  const queryKeyPrefixes: readonly (readonly unknown[])[] = [
    queryKeys.repos(),
    ["repo"],
    ["issues"],
    ["issue"],
    ["pulls"],
    ["pull"],
    queryKeys.agentSessions(),
    queryKeys.events(),
    queryKeys.dashboard(),
    ["settings"],
    ["terminal", "config"],
    terminalKeys.sessions,
  ];

  for (const queryKey of queryKeyPrefixes) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

function openEventSource(
  queryClient: QueryClient,
  broadcast: BroadcastChannel | null,
): () => void {
  const es = new EventSource(streamUrl());

  const onMessage = (e: MessageEvent) => {
    if (typeof e.data !== "string") return;
    broadcast?.postMessage({
      type: "loophub",
      data: e.data,
    } satisfies EventsBroadcast);
    applyLoopHubEventData(e.data, queryClient);
  };

  const onTerminal = () => {
    broadcast?.postMessage({ type: "terminal" } satisfies EventsBroadcast);
    invalidateTerminalQueries(queryClient);
  };

  const onOpen = () => {
    broadcast?.postMessage({
      type: "leader-connected",
    } satisfies EventsBroadcast);
    invalidateReconnectQueries(queryClient);
  };

  // Server uses a named `loophub` event; listen there and on default messages.
  es.addEventListener("loophub", onMessage as EventListener);
  es.addEventListener("message", onMessage as EventListener);
  es.addEventListener("terminal", onTerminal);
  es.addEventListener("open", onOpen);

  return () => {
    es.close();
  };
}

/**
 * Open one cross-tab EventSource to /events and invalidate queries on each event.
 * Mount once near the app root. Web Locks elect a single leader tab; BroadcastChannel
 * fans the leader's events out to follower tabs. EventSource handles reconnects.
 */
export function useLoopHubEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let closeEventSource: (() => void) | null = null;
    let releaseLeader: (() => void) | null = null;
    const locks = navigator.locks;
    const canCoordinateTabs =
      typeof BroadcastChannel !== "undefined" && locks?.request;

    if (!canCoordinateTabs) {
      closeEventSource = openEventSource(queryClient, null);
      return () => {
        closeEventSource?.();
      };
    }

    const abortController = new AbortController();
    const channel = new BroadcastChannel(EVENTS_CHANNEL_NAME);

    const onBroadcast = (e: MessageEvent<EventsBroadcast>) => {
      if (e.data?.type === "loophub") {
        applyLoopHubEventData(e.data.data, queryClient);
      } else if (e.data?.type === "terminal") {
        invalidateTerminalQueries(queryClient);
      } else if (e.data?.type === "leader-connected") {
        invalidateReconnectQueries(queryClient);
      }
    };

    channel.addEventListener("message", onBroadcast);

    void locks
      .request(
        EVENTS_LOCK_NAME,
        { mode: "exclusive", signal: abortController.signal },
        () =>
          new Promise<void>((resolve) => {
            releaseLeader = resolve;
            closeEventSource = openEventSource(queryClient, channel);
          }),
      )
      .catch(() => {
        // Unmount aborts a pending lock request; no user-visible action is needed.
      });

    return () => {
      abortController.abort();
      channel.removeEventListener("message", onBroadcast);
      channel.close();
      closeEventSource?.();
      releaseLeader?.();
    };
  }, [queryClient]);
}
