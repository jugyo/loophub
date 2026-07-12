import { db, now } from "../db.ts";

// Event subscriptions (#1232): rows that tell the worker's generic pub/sub which herdr pane wants
// to be notified when an event type fires in a repo. The store carries no notion of what the
// subscriber does with the notification — that stays entirely on the subscriber side.

export interface EventSubscriptionRow {
  id: number;
  repo_id: number;
  event_type: string;
  herdr_session: string;
  herdr_pane_id: string;
  session_id: string | null;
  created_at: string;
}

export interface AddEventSubscriptionInput {
  repoId: number;
  eventType: string;
  herdrSession: string;
  herdrPaneId: string;
  sessionId?: string | null;
}

// Idempotent insert: the UNIQUE(repo_id, event_type, herdr_session, herdr_pane_id) constraint is
// the duplicate-subscription guard, so re-running `lh subscribe` returns the existing row with
// created=false instead of stacking a second subscription (which would double every notify).
export function addEventSubscription(input: AddEventSubscriptionInput): {
  row: EventSubscriptionRow;
  created: boolean;
} {
  const inserted = db
    .query(
      `INSERT INTO event_subscriptions
         (repo_id, event_type, herdr_session, herdr_pane_id, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, event_type, herdr_session, herdr_pane_id) DO NOTHING
       RETURNING *`,
    )
    .get(
      input.repoId,
      input.eventType,
      input.herdrSession,
      input.herdrPaneId,
      input.sessionId ?? null,
      now(),
    ) as EventSubscriptionRow | undefined;
  if (inserted) return { row: inserted, created: true };
  const existing = db
    .query(
      `SELECT * FROM event_subscriptions
       WHERE repo_id = ? AND event_type = ? AND herdr_session = ? AND herdr_pane_id = ?`,
    )
    .get(
      input.repoId,
      input.eventType,
      input.herdrSession,
      input.herdrPaneId,
    ) as EventSubscriptionRow;
  return { row: existing, created: false };
}

export function listEventSubscriptions(
  repoId?: number | null,
): EventSubscriptionRow[] {
  if (repoId != null) {
    return db
      .query(
        `SELECT * FROM event_subscriptions WHERE repo_id = ? ORDER BY id ASC`,
      )
      .all(repoId) as EventSubscriptionRow[];
  }
  return db
    .query(`SELECT * FROM event_subscriptions ORDER BY id ASC`)
    .all() as EventSubscriptionRow[];
}

// Subscribers to notify for one event occurrence: exact event-type match within the repo.
export function eventSubscriptionsFor(
  repoId: number,
  eventType: string,
): EventSubscriptionRow[] {
  return db
    .query(
      `SELECT * FROM event_subscriptions
       WHERE repo_id = ? AND event_type = ? ORDER BY id ASC`,
    )
    .all(repoId, eventType) as EventSubscriptionRow[];
}

// The db wrapper exposes no changes count, so deletions RETURN the deleted ids and count them —
// callers report "removed N" to the human.
export function removeEventSubscription(id: number): boolean {
  return (
    db
      .query(`DELETE FROM event_subscriptions WHERE id = ? RETURNING id`)
      .all(id).length > 0
  );
}

// Remove a pane's subscriptions — all of them, or narrowed by event type and/or repo (a pane can
// subscribe to the same event type in several repos, so `lh unsubscribe` must be able to drop just
// one repo's row). This is `lh unsubscribe` and the lazy cleanup path (a notify that failed
// because the pane/session is gone).
export function removeEventSubscriptionsForPane(
  herdrSession: string,
  herdrPaneId: string,
  eventType?: string,
  repoId?: number,
): number {
  const clauses = ["herdr_session = ?", "herdr_pane_id = ?"];
  const params: unknown[] = [herdrSession, herdrPaneId];
  if (eventType !== undefined) {
    clauses.push("event_type = ?");
    params.push(eventType);
  }
  if (repoId !== undefined) {
    clauses.push("repo_id = ?");
    params.push(repoId);
  }
  return db
    .query(
      `DELETE FROM event_subscriptions WHERE ${clauses.join(" AND ")} RETURNING id`,
    )
    .all(...params).length;
}
