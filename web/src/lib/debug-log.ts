// Module-level store for the lh-web debug panel (--debug only). Captures the
// event -> invalidation -> refetch trail the panel displays: events the poller
// received, the query keys queryKeysForEvent() mapped them to, and every JSON-RPC
// call with its latency. Kept outside React so the RPC client and the event poller
// (both plain modules) can write to it; the panel reads it via useSyncExternalStore.
//
// Recording is gated on having at least one subscriber, which is the debug panel's
// mount (the panel only renders when webConfig.debug is true), so a non-debug
// lh-web pays nothing.

import { useSyncExternalStore } from "react";
import type { LoopEvent } from "@/api/types";

const MAX_ENTRIES = 300;

export interface EventLogEntry {
  seq: number;
  at: number;
  eventId: number;
  type: string;
  repo?: string;
}

export interface InvalidationLogEntry {
  seq: number;
  at: number;
  eventId: number;
  eventType: string;
  keys: readonly (readonly unknown[])[];
}

export interface RpcLogEntry {
  seq: number;
  at: number;
  method: string;
  params: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface DebugLogState {
  events: EventLogEntry[];
  invalidations: InvalidationLogEntry[];
  rpcs: RpcLogEntry[];
}

let nextSeq = 1;
let state: DebugLogState = {
  events: [],
  invalidations: [],
  rpcs: [],
};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to log changes. Returns an unsubscribe function. */
export function subscribeDebugLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDebugLogSnapshot(): DebugLogState {
  return state;
}

/** Append to a bounded list, dropping the oldest entries past MAX_ENTRIES. */
function append<T>(list: readonly T[], entry: T): T[] {
  const next = [...list, entry];
  return next.length > MAX_ENTRIES
    ? next.slice(next.length - MAX_ENTRIES)
    : next;
}

/** Append a batch, dropping the oldest entries past MAX_ENTRIES. */
function appendMany<T>(list: readonly T[], entries: readonly T[]): T[] {
  const next = [...list, ...entries];
  return next.length > MAX_ENTRIES
    ? next.slice(next.length - MAX_ENTRIES)
    : next;
}

function record(mutate: (prev: DebugLogState) => DebugLogState): void {
  if (listeners.size === 0) return;
  state = mutate(state);
  emit();
}

/** Record a batch of events the poller received, in arrival order. */
export function recordEvents(events: readonly LoopEvent[]): void {
  record((prev) => ({
    ...prev,
    events: appendMany(
      prev.events,
      events.map((event, index) => ({
        seq: nextSeq++,
        at: Date.now() + index,
        eventId: event.id,
        type: event.type,
        repo: event.repo,
      })),
    ),
  }));
}

/** Record the query keys an event invalidated (queryKeysForEvent's result). */
export function recordInvalidation(
  event: LoopEvent,
  keys: readonly (readonly unknown[])[],
): void {
  record((prev) => ({
    ...prev,
    invalidations: append(prev.invalidations, {
      seq: nextSeq++,
      at: Date.now(),
      eventId: event.id,
      eventType: event.type,
      keys,
    }),
  }));
}

/** Record one JSON-RPC call: method, params, and wall-clock duration. */
export function recordRpc(input: {
  method: string;
  params: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
  error?: string;
}): void {
  record((prev) => ({
    ...prev,
    rpcs: append(prev.rpcs, {
      seq: nextSeq++,
      at: Date.now(),
      ...input,
    }),
  }));
}

/** Empty every log. The panel calls this from its Clear button. */
export function clearDebugLog(): void {
  state = {
    events: [],
    invalidations: [],
    rpcs: [],
  };
  emit();
}

/**
 * Subscribe to the debug logs. Pass `enabled` so a non-debug build never
 * subscribes (and therefore never records).
 */
export function useDebugLog(enabled: boolean): DebugLogState {
  return useSyncExternalStore(
    enabled ? subscribeDebugLog : () => () => {},
    getDebugLogSnapshot,
    getDebugLogSnapshot,
  );
}
