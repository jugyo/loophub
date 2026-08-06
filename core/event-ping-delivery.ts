// Delivery side of the ping seam: who asked to be woken by a stored event, and the wake-up itself.
//
// The routing question is answered from the subscription tables alone — "who subscribed to
// pull:2381" — never by walking from an event to the runs it might concern. A subscriber declares
// what it wants to be woken by; this module does not know why, and it does not read a subscriber's
// domain object to decide whether to deliver.
//
// Everything here is best-effort. A ping that is not delivered is logged and dropped: there is no
// retry, no acknowledgement and no queue, because a subscriber reads current state on any later
// ping and a human can always wake it by typing into its pane.

import { db } from "./db.ts";
import { type EventPingIntent, eventPingIntent } from "./event-ping.ts";
import { sendHerdrPrompt } from "./service/herdr-prompt.ts";
import {
  type EventSubscriberRow,
  listEventSubscribersForResource,
} from "./store/event-subscriptions.ts";
import { getRepoById } from "./store/repos.ts";

const HERDR_TIMEOUT_MS = 15_000;

/** The columns a ping reads off the event row it announces. */
export interface EventPingSource {
  repo_id: number | null;
  type: string;
  payload: string;
}

export type EventPingLogger = (message: string) => void;

/** One wake-up, addressed to one subscriber. */
interface EventPing {
  subscription: EventSubscriberRow;
  resources: string[];
}

/**
 * The line a woken subscriber receives.
 *
 * It carries the subscription and the resources and nothing else — no event id, no action, no
 * comment text. A subscriber that cannot read anything into the notification has to read current
 * state, which is the only place the truth is; and untrusted text (a review body, a comment) never
 * travels through the wake-up path at all.
 */
export function eventPingText(ping: EventPing): string {
  return `ping subscription=${ping.subscription.id} resources=${ping.resources.join(",")}`;
}

// A subscription may have registered several of the resources one event names — a run's parent
// subscribes to the run, its issue and its PR — and that is still one thing to look at, so the
// subscriber is woken once with every resource that matched.
function pingsForIntent(repoId: number, intent: EventPingIntent): EventPing[] {
  const pings = new Map<number, EventPing>();
  for (const resource of intent.resources) {
    const subscribers = listEventSubscribersForResource({
      repoId,
      resourceKind: resource.kind,
      resourceKey: resource.key,
    });
    for (const subscription of subscribers) {
      const key = `${resource.kind}:${resource.key}`;
      const existing = pings.get(subscription.id);
      if (existing) existing.resources.push(key);
      else pings.set(subscription.id, { subscription, resources: [key] });
    }
  }
  return [...pings.values()];
}

async function deliver(
  ping: EventPing,
  logError: EventPingLogger,
): Promise<void> {
  const { subscription } = ping;
  try {
    const repo = getRepoById(subscription.repo_id);
    if (!repo || !subscription.session_name || !subscription.herdr_pane_id) {
      logError(
        `lh: event ping undeliverable subscription_id=${subscription.id} reason=pane-coordinates-missing`,
      );
      return;
    }
    await sendHerdrPrompt({
      sessionName: subscription.session_name,
      paneId: subscription.herdr_pane_id,
      text: eventPingText(ping),
      cwd: repo.local_path,
      timeoutMs: HERDR_TIMEOUT_MS,
    });
  } catch (error) {
    // A pane that is gone, or a Herdr that will not run, is a wake-up nobody got. It is reported
    // for a human to act on and not retried: the subscriber reads current state on any later ping.
    logError(
      `lh: event ping delivery failed subscription_id=${subscription.id} pane_id=${subscription.herdr_pane_id} error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Wake every subscriber of one stored event, once the write is durable.
 *
 * The caller is not blocked and its result does not change: the pane writes are started and left to
 * finish on their own, the way a Web-to-CLI call never waits on the subprocess it triggers. A
 * command that waited here would hang on a dead agent's pane.
 */
export function pingEventSubscribers(
  event: EventPingSource,
  logError: EventPingLogger = console.error,
): void {
  if (event.repo_id === null) return;
  const repoId = event.repo_id;
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    return;
  }
  const intent = eventPingIntent(event.type, payload);
  if (!intent) return;
  db.afterCommit(() => {
    try {
      for (const ping of pingsForIntent(repoId, intent)) {
        void deliver(ping, logError);
      }
    } catch (error) {
      logError(
        `lh: event ping resolution failed event_type=${event.type} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}
