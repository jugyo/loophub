// Event delivery as JSON-RPC notifications. Transport-neutral: subscribeEvents replays
// persisted events since a cursor, then live-subscribes to the in-process hub, handing each
// event to `onNotification` as a JSON-RPC notification frame. The lh-web process (S3) binds
// this to an SSE response; tests drive it directly. Feature parity with the prototype's
// GET /events/stream (replay-then-subscribe, repo filter, ascending-by-id cursor).
import {
  formatEvent,
  type LoopEvent,
  publishEvent,
  subscribe,
} from "../../core/event-hub.ts";
import { HERDR_INACTIVE_CLEANUP_INTERVAL_MS } from "../../core/herdr-inactive-cleanup.ts";
import { sessions, terminal } from "../../core/service.ts";
import * as S from "../../core/store.ts";
import {
  publish as publishTerminalChange,
  listenerCount as terminalWatchListenerCount,
} from "../../core/terminal-watch-hub.ts";
import { sweepPullUpdates } from "../../core/watcher.ts";
import { log } from "./logger.ts";

const REPLAY_PAGE = 100;
const DEFAULT_TAIL_POLL_MS = 1000;
export const DEFAULT_SWEEP_MS = 5000;
export const DEFAULT_USAGE_SWEEP_MS = 10000;
export const DEFAULT_HERDR_WATCH_MS = 3000;
export const DEFAULT_HERDR_INACTIVE_CLEANUP_MS =
  HERDR_INACTIVE_CLEANUP_INTERVAL_MS;

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
    const repo =
      repoParam ??
      (row.repo_id != null ? S.getRepoById(row.repo_id)?.full_name : undefined);
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
      const repo =
        row.repo_id != null ? S.getRepoById(row.repo_id)?.full_name : undefined;
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

// Auto-fire pull_request.updated by sweeping open PR head SHAs on the resident lh-web process.
// Without this, pull_request.updated only fires from `lh sync` (CLI) / `sync/run` (RPC); if
// nobody runs sync, the review cycle stalls. We poll open PR head refs on an interval and let
// sweepPullUpdates() write pull_request.updated rows straight to the shared DB — startEventTail
// above forwards them to SSE subscribers. Unchanged PRs are a no-op (no DB write), and `lh sync`
// / `sync/run` remain as a manual force. The sweep does git work per PR, so it runs on its own,
// coarser interval (not the 1s event tail) and skips a tick if a prior sweep is still running.
export function startPullSweep(intervalMs = DEFAULT_SWEEP_MS): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return; // skip overlap if a prior sweep is still in flight
    running = true;
    try {
      await sweepPullUpdates();
    } catch (err) {
      log.error(
        `pull sweep error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Keep token usage fresh while lh-web is resident. The core service owns transcript
// cursoring and parsing; this loop only schedules the sync and emits invalidation events for
// sessions that actually changed. Unchanged transcripts are skipped by mtime/size before parsing.
export function startUsageSweep(
  intervalMs = DEFAULT_USAGE_SWEEP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = sessions.usageSync();
      for (const session of result.sessions) {
        if (session.status !== "updated") continue;
        const actor = S.authorFromSession(session.session_id) ?? "lh-web";
        const payload = {
          session_id: session.session_id,
          messages: session.messages,
        };
        const targets = S.listSessionLinkedTargets(session.session_id);
        if (targets.length === 0) {
          S.emitEvent(null, "agent_session.usage_updated", actor, payload);
          continue;
        }
        for (const target of targets) {
          S.emitEvent(target.repo_id, "agent_session.usage_updated", actor, {
            ...payload,
            [target.kind === "pull" ? "pr" : "issue"]: target.number,
          });
        }
      }
    } catch (err) {
      log.error(
        `usage sweep error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Poll herdr session state on the server so N open browser tabs share ONE herdr CLI spawn
// per tick instead of each tab polling independently (#591). Gated on
// terminal-watch-hub's listenerCount(), which equals the number of open SSE connections
// (see web/server/http.ts): with nobody watching the sidebar, herdr is never shelled out.
// Diffs the snapshot with a JSON-string comparison and only publishes -- a bare "invalidate"
// signal, no payload -- when the snapshot actually changed, so idle sessions don't push an
// SSE frame every tick. Unlike startPullSweep, this never writes to the events table: herdr
// state is a transient observation, not a persisted, replayable event (see #591's design
// notes on the issue).
export function startHerdrWatch(
  intervalMs = DEFAULT_HERDR_WATCH_MS,
): () => void {
  let stopped = false;
  let running = false;
  let lastSnapshot: string | null = null;

  const tick = async () => {
    if (stopped || running) return;
    if (terminalWatchListenerCount() === 0) return; // nobody watching -> skip the herdr spawn
    running = true;
    try {
      const snapshot = JSON.stringify(await terminal.sessions());
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot;
        publishTerminalChange();
      }
    } catch (err) {
      log.error(
        `herdr watch error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// Close old Herdr panes from the backend on a coarse interval (#666). Unlike the sidebar
// watcher above, this is not gated on SSE listeners: the cleanup is process-owned
// maintenance, not a UI cache invalidation. The service closes inactive candidate panes
// (including PR-closed or no-PR idle cases) with a valid pane id and a known >=10 minute age.
export function startHerdrInactiveCleanup(
  intervalMs = DEFAULT_HERDR_INACTIVE_CLEANUP_MS,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await terminal.cleanupInactiveAgents();
      if (result.closed > 0 || result.failed > 0) {
        log.info(
          `herdr inactive cleanup: closed ${result.closed}, failed ${result.failed}`,
        );
      }
    } catch (err) {
      log.error(
        `herdr inactive cleanup error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
