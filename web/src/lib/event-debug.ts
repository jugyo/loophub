import { useSyncExternalStore } from "react";
import type { LoopEvent } from "@/api/types";

export const EVENT_DEBUG_LIMIT = 200;

export type EventDebugEntry =
  | {
      sequence: number;
      source: "loophub";
      received_at: string;
      event: LoopEvent;
      raw: string;
    }
  | {
      sequence: number;
      source: "invalid-loophub";
      received_at: string;
      raw: string;
      reason: string;
    }
  | {
      sequence: number;
      source: "terminal";
      received_at: string;
    };

let sequence = 0;
let entries: EventDebugEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function push(entry: EventDebugEntry): void {
  entries = [entry, ...entries].slice(0, EVENT_DEBUG_LIMIT);
  emit();
}

export function recordLoopHubDebugEvent(event: LoopEvent, raw: string): void {
  push({
    sequence: ++sequence,
    source: "loophub",
    received_at: new Date().toISOString(),
    event,
    raw,
  });
}

export function recordInvalidLoopHubDebugEvent(
  raw: string,
  reason: string,
): void {
  push({
    sequence: ++sequence,
    source: "invalid-loophub",
    received_at: new Date().toISOString(),
    raw,
    reason,
  });
}

export function recordTerminalDebugEvent(): void {
  push({
    sequence: ++sequence,
    source: "terminal",
    received_at: new Date().toISOString(),
  });
}

export function useEventDebugEntries(): EventDebugEntry[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => entries,
    () => entries,
  );
}

export function resetEventDebugEntriesForTest(): void {
  sequence = 0;
  entries = [];
  emit();
}

export function getEventDebugEntriesForTest(): EventDebugEntry[] {
  return entries;
}
