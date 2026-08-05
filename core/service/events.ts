import { randomUUID } from "node:crypto";
import { ServiceError } from "../errors.ts";
import { formatEvent, type LoopEvent } from "../events.ts";
import {
  type EventSubscriptionWire,
  eventSubscriptionJSON,
} from "../serialize.ts";
import * as S from "../store.ts";
import { clampPerPage, MAX_EVENTS_PER_PAGE, repoOr404 } from "./shared.ts";

const SUBSCRIPTION_TARGETS: S.EventSubscriptionTarget[] = ["herdr-pane"];

function isSubscriptionTarget(
  target: string,
): target is S.EventSubscriptionTarget {
  return SUBSCRIPTION_TARGETS.includes(target as S.EventSubscriptionTarget);
}

// `<kind>:<key>`, where the key keeps whatever a resource uses as its identifier — issue and PR
// numbers today, but the key is not restricted to digits so a future resource can be named by a
// string. Only the first colon separates the two.
function parseSubscriptionResource(
  raw: string,
): S.EventSubscriptionResourceInput {
  const match = /^([a-z][a-z0-9_]*):(.+)$/.exec(raw);
  if (!match) {
    throw new ServiceError(
      422,
      `resource must be <kind>:<key>, for example workflow_run:618: ${raw}`,
    );
  }
  return { resourceKind: match[1], resourceKey: match[2] };
}

// The pane a subscriber names may predate LoopHub's own pane registry — a human's pane, or one
// launched by something other than a LoopHub flow. Registering it from its coordinates keeps the
// command generic; the pane row is a place to hold those coordinates, not a claim on the pane's
// lifetime.
function subscriptionPane(
  repoId: number,
  sessionName: string,
  paneId: string,
): S.HerdrPaneRow {
  const existing = S.getHerdrPaneByCoordinates(repoId, sessionName, paneId);
  if (existing) return existing;
  return S.registerHerdrPane({
    repoId,
    launchId: randomUUID(),
    paneId,
    sessionName,
    origin: "event-subscription",
  });
}

// ===== events =====
export const events = {
  list(
    opts: {
      since?: number;
      repo?: string | null;
      labels?: string[];
      types?: string[];
      runId?: number;
      order?: "asc" | "desc";
      limit?: number;
    } = {},
  ): LoopEvent[] {
    const since = Number(opts.since ?? 0);
    const limit = clampPerPage(
      opts.limit,
      MAX_EVENTS_PER_PAGE,
      MAX_EVENTS_PER_PAGE,
    );
    const labels = opts.labels ?? [];
    const order = opts.order === "desc" ? "desc" : "asc";
    let repoId: number | null = null;
    if (opts.repo) {
      const [o, n] = opts.repo.split("/");
      const r = S.getRepo(o, n);
      if (!r) return []; // unknown repo filter -> empty
      repoId = r.id;
    }
    const rows = S.listEvents(since, repoId, limit, labels, order, {
      types: opts.types,
      runId: opts.runId,
    });
    return rows.map((row) => {
      const repo =
        opts.repo ??
        (row.repo_id != null
          ? S.getRepoById(row.repo_id)?.full_name
          : undefined);
      return formatEvent(row, repo);
    });
  },

  // Thin pass-through so callers outside core/, such as lh-worker, don't reach into core/store
  // directly to write an event.
  emit(
    repoId: number | null,
    type: string,
    actor: string,
    payload: unknown,
  ): S.EventRow {
    return S.emitEvent(repoId, type, actor, payload);
  },

  // Single bounded page of raw event rows after `since` (repoId filter, or null = all repos),
  // ascending by id — a direct pass-through with no formatting. Used where a caller manages its
  // own paging/cursor loop, including lh-worker's event dispatch loop.
  page(
    since: number,
    repoId: number | null,
    limit: number,
    filters?: S.EventFilters,
  ): S.EventRow[] {
    return S.listEvents(since, repoId, limit, undefined, "asc", filters);
  },

  // Highest known event id, or 0 if none exist yet. Used to seed a tail/worker cursor at
  // startup so it only sees events from this point forward.
  newestId(): number {
    const newest = S.listEvents(0, null, 1, undefined, "desc");
    return newest.length ? newest[0].id : 0;
  },

  // Register "wake this target when any of these resources changes". The subscriber declares its
  // own interest; nothing here inspects what the resources mean or how long the subscription
  // should live. Releasing it is subscribe's counterpart, `unsubscribe`, and is the subscriber's
  // call too.
  subscribe(input: {
    repo: string;
    target: string;
    session: string;
    pane: string;
    resources: string[];
  }): EventSubscriptionWire {
    const r = repoOr404(input.repo);
    if (!isSubscriptionTarget(input.target)) {
      throw new ServiceError(
        422,
        `target must be one of ${SUBSCRIPTION_TARGETS.join(", ")}: ${input.target}`,
      );
    }
    if (!input.session) throw new ServiceError(422, "session is required");
    if (!input.pane) throw new ServiceError(422, "pane is required");
    if (input.resources.length === 0) {
      throw new ServiceError(422, "at least one resource is required");
    }
    const resources = input.resources.map(parseSubscriptionResource);
    const pane = subscriptionPane(r.id, input.session, input.pane);
    const subscription = S.createEventSubscription({
      repoId: r.id,
      target: input.target,
      paneId: pane.id,
      resources,
    });
    return eventSubscriptionJSON(
      subscription,
      S.listEventSubscriptionResources(subscription.id),
    );
  },

  unsubscribe(input: { subscription: number }): { id: number } {
    if (!S.deleteEventSubscription(input.subscription)) {
      throw new ServiceError(404, "Not Found");
    }
    return { id: input.subscription };
  },
};
