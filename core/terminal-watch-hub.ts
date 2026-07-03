/**
 * In-process pub/sub for ephemeral herdr session-state change notifications (#591).
 *
 * Unlike core/event-hub.ts, these notifications are never persisted to the `events` table and
 * carry no id/replay semantics -- a missed notification is recovered by the next JSON-RPC
 * refetch, not by resubscribing with a cursor. listenerCount() also doubles as "is anyone
 * watching the terminal sidebar right now": the herdr watcher (web/server/events.ts) polls it
 * to decide whether to keep shelling out to herdr at all.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publish(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (e) {
      console.error("terminal-watch-hub listener error:", e);
    }
  }
}

/** Number of open SSE connections currently subscribed (see web/server/http.ts). */
export function listenerCount(): number {
  return listeners.size;
}
