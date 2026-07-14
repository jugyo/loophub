import {
  buildNotifyText,
  notifiableEventType,
  SUBSCRIPTION_EVENT_PREFIX,
} from "../event-subscriptions.ts";
import type { EventRow } from "../store/events.ts";
import type { EventSubscriptionRow } from "../store/subscriptions.ts";
import { runHerdrCapture } from "./herdr-runner.ts";
import { repoOr404, S, ServiceError } from "./shared.ts";

// The worker's generic event pub/sub (#1232). Registration comes from `lh subscribe` (an agent
// session passing its own HERDR_SESSION / HERDR_PANE_ID); delivery is notifyForEvent, called by
// the worker's event tail for every event row. The worker/service side knows only "inject this
// text into that pane" — what the subscriber does in response is the subscriber's wiring.

export interface EventSubscription extends EventSubscriptionRow {
  repo: string;
}

export interface NotifyFailure {
  subscription_id: number;
  herdr_session: string;
  herdr_pane_id: string;
  error: string;
}

export interface NotifyResult {
  notified: number;
  removed: number;
  failures: NotifyFailure[];
}

function withRepo(row: EventSubscriptionRow): EventSubscription {
  return { ...row, repo: S.getRepoById(row.repo_id)?.full_name ?? "" };
}

function requireNonEmpty(value: string | undefined, flag: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new ServiceError(422, `${flag} is required`);
  return v;
}

// Stored pane identity and event type end up as argv values of the worker's herdr spawn. spawn()
// passes an argv array (no shell), but a leading "-" would still be parsed by herdr's own CLI as a
// flag, letting a subscription row reshape the worker's herdr invocation — so reject anything
// outside a plain token (and any leading "-") at registration time.
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;

function requireSafeToken(value: string | undefined, flag: string): string {
  const v = requireNonEmpty(value, flag);
  if (!SAFE_TOKEN.test(v))
    throw new ServiceError(
      422,
      `${flag} must match ${SAFE_TOKEN} (no leading "-", no spaces)`,
    );
  return v;
}

export const subscriptions = {
  add(input: {
    repo: string;
    eventType: string;
    herdrSession: string;
    herdrPaneId: string;
    sessionId?: string | null;
  }): { subscription: EventSubscription; created: boolean } {
    const repo = repoOr404(input.repo);
    const eventType = requireSafeToken(input.eventType, "event type");
    // The audit namespace is excluded from delivery (see notifiableEventType), so registering it
    // would print "subscribed" for a subscription that can never fire — reject it visibly instead.
    if (!notifiableEventType(eventType))
      throw new ServiceError(
        422,
        `${SUBSCRIPTION_EVENT_PREFIX}* events are not deliverable`,
      );
    const { row, created } = S.addEventSubscription({
      repoId: repo.id,
      eventType,
      herdrSession: requireSafeToken(input.herdrSession, "herdr session"),
      herdrPaneId: requireSafeToken(input.herdrPaneId, "herdr pane id"),
      sessionId: input.sessionId ?? null,
    });
    return { subscription: withRepo(row), created };
  },

  // Remove the calling pane's subscriptions (all, one event type, and/or one repo). Pane-scoped on
  // purpose: an agent cleans up after itself and cannot unsubscribe another pane by accident.
  removeForPane(input: {
    herdrSession: string;
    herdrPaneId: string;
    eventType?: string;
    repo?: string | null;
  }): { removed: number } {
    return {
      removed: S.removeEventSubscriptionsForPane(
        requireNonEmpty(input.herdrSession, "herdr session"),
        requireNonEmpty(input.herdrPaneId, "herdr pane id"),
        input.eventType,
        input.repo ? repoOr404(input.repo).id : undefined,
      ),
    };
  },

  list(opts: { repo?: string | null } = {}): EventSubscription[] {
    const repoId = opts.repo ? repoOr404(opts.repo).id : null;
    return S.listEventSubscriptions(repoId).map(withRepo);
  },

  // Deliver one event row to its subscribers by injecting a text line into each subscribed herdr
  // pane. Subscription lifecycle is lazy cleanup: there is no resident liveness tracking — a
  // subscription whose pane/session is gone simply fails its next notify and is deleted then,
  // visibly (the caller logs the failures). No retries: a missed notification is human-recoverable
  // (the event row is still in the events table).
  async notifyForEvent(
    row: EventRow,
    deps: {
      inject?: (sub: EventSubscriptionRow, text: string) => Promise<unknown>;
      actor?: string;
    } = {},
  ): Promise<NotifyResult> {
    const result: NotifyResult = { notified: 0, removed: 0, failures: [] };
    if (row.repo_id == null || !notifiableEventType(row.type)) return result;
    let subs = S.eventSubscriptionsFor(row.repo_id, row.type);
    if (subs.length === 0) return result;
    const repoFullName = S.getRepoById(row.repo_id)?.full_name ?? "";
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
    if (row.type === "pull_request.github_feedback") {
      const parentSessionId = (payload as { parent_session_id?: unknown })
        .parent_session_id;
      if (typeof parentSessionId !== "string") return result;
      subs = subs.filter((sub) => sub.session_id === parentSessionId);
      if (subs.length === 0) return result;
    }
    const number = (payload as { number?: unknown })?.number;
    const githubUrl = (payload as { github_url?: unknown })?.github_url;
    const rawFeedback = (payload as { feedback?: unknown })?.feedback;
    const feedbackRefs = Array.isArray(rawFeedback)
      ? rawFeedback.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const item = value as {
            kind?: unknown;
            id?: unknown;
            reference?: unknown;
          };
          if (
            typeof item.kind !== "string" ||
            typeof item.id !== "number" ||
            !Number.isSafeInteger(item.id) ||
            typeof item.reference !== "string"
          ) {
            return [];
          }
          return [{ kind: item.kind, id: item.id, reference: item.reference }];
        })
      : undefined;
    const text = buildNotifyText({
      eventType: row.type,
      repoFullName,
      eventId: row.id,
      number: typeof number === "number" ? number : undefined,
      githubPr: typeof githubUrl === "string" ? githubUrl : undefined,
      feedbackRefs,
    });
    const inject =
      deps.inject ??
      ((sub: EventSubscriptionRow, t: string) =>
        runHerdrCapture([
          "--session",
          sub.herdr_session,
          "pane",
          "run",
          sub.herdr_pane_id,
          t,
        ]));
    for (const sub of subs) {
      try {
        await inject(sub, text);
      } catch (e) {
        S.removeEventSubscription(sub.id);
        result.removed++;
        result.failures.push({
          subscription_id: sub.id,
          herdr_session: sub.herdr_session,
          herdr_pane_id: sub.herdr_pane_id,
          error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      result.notified++;
      // The audit row is best-effort: only a failed *injection* means a dead pane, so a transient
      // DB error here must neither delete the live subscription nor abort remaining deliveries.
      try {
        S.emitEvent(
          row.repo_id,
          "event_subscription.notified",
          deps.actor ?? "lh-worker",
          {
            number: typeof number === "number" ? number : undefined,
            subscription_id: sub.id,
            source_event_id: row.id,
            source_type: row.type,
            herdr_pane_id: sub.herdr_pane_id,
          },
        );
      } catch {}
    }
    return result;
  },
};
