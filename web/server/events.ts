// Event delivery as JSON-RPC notifications. Transport-neutral: subscribeEvents replays
// persisted events since a cursor, then live-subscribes to the in-process hub, handing each
// event to `onNotification` as a JSON-RPC notification frame. The lh-web process (S3) binds
// this to an SSE response; tests drive it directly. Feature parity with the prototype's
// GET /events/stream (replay-then-subscribe, repo filter, ascending-by-id cursor).
import { formatEvent, subscribe, type LoopEvent } from "../../core/event-hub.ts";
import * as S from "../../core/store.ts";

const REPLAY_PAGE = 100;

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
