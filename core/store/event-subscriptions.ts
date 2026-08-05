import { db, now } from "../db.ts";

export type EventSubscriptionTarget = "herdr-pane";

export interface EventSubscriptionRow {
  id: number;
  repo_id: number;
  target: EventSubscriptionTarget;
  pane_id: number;
  created_at: string;
}

export interface EventSubscriptionResourceRow {
  subscription_id: number;
  resource_kind: string;
  resource_key: string;
  created_at: string;
}

export interface EventSubscriptionResourceInput {
  resourceKind: string;
  resourceKey: string;
}

/** A subscription with the pane coordinates a wake-up needs, resolved in one read. */
export interface EventSubscriberRow extends EventSubscriptionRow {
  session_name: string | null;
  herdr_pane_id: string | null;
}

// The subscription row and its resource rows are one declaration: a subscription with no resource
// would never be woken, and a resource row with no subscription has no target. They are written
// together so a failed insert leaves neither behind.
export function createEventSubscription(input: {
  repoId: number;
  target: EventSubscriptionTarget;
  paneId: number;
  resources: EventSubscriptionResourceInput[];
}): EventSubscriptionRow {
  return db.transaction(() => {
    const t = now();
    const row = db
      .query(
        `INSERT INTO event_subscriptions (repo_id, target, pane_id, created_at)
         VALUES (?, ?, ?, ?) RETURNING *`,
      )
      .get(input.repoId, input.target, input.paneId, t) as EventSubscriptionRow;
    for (const resource of input.resources) {
      db.run(
        `INSERT OR IGNORE INTO event_subscription_resources
           (subscription_id, resource_kind, resource_key, created_at)
         VALUES (?, ?, ?, ?)`,
        [row.id, resource.resourceKind, resource.resourceKey, t],
      );
    }
    return row;
  });
}

export function getEventSubscription(id: number): EventSubscriptionRow | null {
  return db
    .query(`SELECT * FROM event_subscriptions WHERE id = ?`)
    .get(id) as EventSubscriptionRow | null;
}

export function listEventSubscriptionResources(
  subscriptionId: number,
): EventSubscriptionResourceRow[] {
  return db
    .query(
      `SELECT * FROM event_subscription_resources
       WHERE subscription_id = ?
       ORDER BY resource_kind, resource_key`,
    )
    .all(subscriptionId) as EventSubscriptionResourceRow[];
}

// Deleting the subscription cascades to its resource rows. A subscription describes a live wish to
// be woken, not history, so releasing it leaves nothing to keep.
export function deleteEventSubscription(id: number): boolean {
  return db.transaction(() => {
    if (!getEventSubscription(id)) return false;
    db.run(`DELETE FROM event_subscriptions WHERE id = ?`, [id]);
    return true;
  });
}

// The delivery-side lookup: given a resource that changed, who asked to be woken for it. Answered
// from the subscription tables alone.
export function listEventSubscribersForResource(input: {
  repoId: number;
  resourceKind: string;
  resourceKey: string;
}): EventSubscriberRow[] {
  return db
    .query(
      `SELECT s.*, p.session_name AS session_name, p.pane_id AS herdr_pane_id
       FROM event_subscriptions s
       JOIN event_subscription_resources r ON r.subscription_id = s.id
       JOIN herdr_panes p ON p.id = s.pane_id
       WHERE s.repo_id = ? AND r.resource_kind = ? AND r.resource_key = ?
       ORDER BY s.created_at, s.id`,
    )
    .all(
      input.repoId,
      input.resourceKind,
      input.resourceKey,
    ) as EventSubscriberRow[];
}
