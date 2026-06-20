// Event delivery as JSON-RPC notifications. Transport-neutral: subscribeEvents replays
// persisted events since a cursor, then live-subscribes to the in-process hub, handing each
// event to `onNotification` as a JSON-RPC notification frame. The lh-web process (S3) binds
// this to an SSE response; tests drive it directly. Feature parity with the prototype's
// GET /events/stream (replay-then-subscribe, repo filter, ascending-by-id cursor).
import { formatEvent, publishEvent, subscribe, type LoopEvent } from "../../core/event-hub.ts";
import * as S from "../../core/store.ts";

const REPLAY_PAGE = 100;
const DEFAULT_TAIL_POLL_MS = 1000;

export interface EventNotification {
  jsonrpc: "2.0";
  method: "events/notify";
  params: LoopEvent;
}

export function eventNotification(event: LoopEvent): EventNotification {
  return { jsonrpc: "2.0", method: "events/notify", params: event };
}

export interface SubscribeOptions {
  since?: number;
  repo?: string | null;
}

// Replay events after `since`, then deliver live events. Returns an unsubscribe function.
// `onNotification` receives ascending-by-id frames; ids never regress across replay->live.
export function subscribeEvents(
  opts: SubscribeOptions,
  onNotification: (n: EventNotification) => void,
): () => void {
  const since = Number(opts.since ?? 0);
  const repoParam = opts.repo ?? null;

  let repoId: number | null = null;
  if (repoParam) {
    const [o, n] = repoParam.split("/");
    const r = S.getRepo(o, n);
    repoId = r ? r.id : -1; // unknown repo -> nothing to replay, live filter never matches
  }

  let cursor = since;

  const toEvent = (row: any): LoopEvent => {
    const repo = repoParam ?? (row.repo_id != null ? S.getRepoById(row.repo_id)?.full_name : undefined);
    return formatEvent(row, repo);
  };

  if (repoId !== -1) {
    let pageSince = since;
    for (;;) {
      const rows = S.listEvents(pageSince, repoId, REPLAY_PAGE);
      if (rows.length === 0) break;
      for (const row of rows) {
        const event = toEvent(row);
        if (event.id <= cursor) continue;
        onNotification(eventNotification(event));
        cursor = Math.max(cursor, event.id);
      }
      if (rows.length < REPLAY_PAGE) break;
      pageSince = rows[rows.length - 1].id;
    }
  }

  return subscribe((event) => {
    if (repoParam && event.repo !== repoParam) return;
    if (event.id <= cursor) return;
    onNotification(eventNotification(event));
    cursor = event.id;
  });
}

// Cross-process liveness: the in-process pub/sub (event-hub) only sees events emitted in THIS
// process, but the CLI/agents write directly to the shared SQLite DB in their own processes.
// lh-web tails the `events` table by id cursor and republishes new rows through the pub/sub,
// so subscribeEvents subscribers (SSE) get CLI/agent changes live (deduped by each
// subscriber's own cursor). Starts from the current newest id; per-connection replay covers
// history.
export function startEventTail(pollMs = DEFAULT_TAIL_POLL_MS): () => void {
  const newest = S.listEvents(0, null, 1, undefined, "desc");
  let cursor = newest.length ? newest[0].id : 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    for (const row of S.listEvents(cursor, null, REPLAY_PAGE)) {
      const repo = row.repo_id != null ? S.getRepoById(row.repo_id)?.full_name : undefined;
      publishEvent(formatEvent(row, repo));
      cursor = Math.max(cursor, row.id);
    }
  };

  const timer = setInterval(tick, pollMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
