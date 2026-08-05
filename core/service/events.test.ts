import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-event-subscriptions-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

const REPO = "me/subscriptions";

let events: typeof import("./events.ts")["events"];
let S: typeof import("../store.ts");
let repoId: number;

function subscribe(resources: string[], pane = "w1:p2") {
  return events.subscribe({
    repo: REPO,
    target: "herdr-pane",
    session: "me-subscriptions",
    pane,
    resources,
  });
}

beforeAll(async () => {
  S = await import("../store.ts");
  events = (await import("./events.ts")).events;
  repoId = S.createRepo(REPO, HOME).id;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("subscribe records every declared resource and unsubscribe releases them", () => {
  const subscription = subscribe([
    "workflow_run:618",
    "issue:2371",
    "pull:2379",
  ]);

  expect(subscription.target).toBe("herdr-pane");
  expect(subscription.resources).toEqual([
    { resource_kind: "issue", resource_key: "2371" },
    { resource_kind: "pull", resource_key: "2379" },
    { resource_kind: "workflow_run", resource_key: "618" },
  ]);

  expect(events.unsubscribe({ subscription: subscription.id })).toEqual({
    id: subscription.id,
  });
  expect(S.getEventSubscription(subscription.id)).toBeNull();
  expect(S.listEventSubscriptionResources(subscription.id)).toEqual([]);
});

test("unsubscribing an unknown subscription fails visibly", () => {
  expect(() => events.unsubscribe({ subscription: 999999 })).toThrow(
    expect.objectContaining({ status: 404 }),
  );
});

test("subscribers for a resource are answered from the subscription tables alone", () => {
  const subscription = subscribe(["workflow_run:700"], "w9:p1");

  const subscribers = S.listEventSubscribersForResource({
    repoId,
    resourceKind: "workflow_run",
    resourceKey: "700",
  });

  expect(subscribers).toHaveLength(1);
  expect(subscribers[0]).toMatchObject({
    id: subscription.id,
    target: "herdr-pane",
    session_name: "me-subscriptions",
    herdr_pane_id: "w9:p1",
  });
  expect(
    S.listEventSubscribersForResource({
      repoId,
      resourceKind: "workflow_run",
      resourceKey: "701",
    }),
  ).toEqual([]);

  events.unsubscribe({ subscription: subscription.id });
  expect(
    S.listEventSubscribersForResource({
      repoId,
      resourceKind: "workflow_run",
      resourceKey: "700",
    }),
  ).toEqual([]);
});

test("subscribe rejects an unsupported target and a malformed resource", () => {
  expect(() =>
    events.subscribe({
      repo: REPO,
      target: "webhook",
      session: "me-subscriptions",
      pane: "w1:p2",
      resources: ["issue:1"],
    }),
  ).toThrow(expect.objectContaining({ status: 422 }));

  expect(() => subscribe(["2371"])).toThrow(
    expect.objectContaining({ status: 422 }),
  );
  expect(() => subscribe([])).toThrow(expect.objectContaining({ status: 422 }));
});

test("subscribing twice from the same pane reuses its registered coordinates", () => {
  const first = subscribe(["issue:10"], "w2:p3");
  const second = subscribe(["issue:11"], "w2:p3");

  expect(second.id).not.toBe(first.id);
  const panes = S.listEventSubscribersForResource({
    repoId,
    resourceKind: "issue",
    resourceKey: "10",
  });
  expect(panes).toHaveLength(1);
  expect(S.getEventSubscription(second.id)?.pane_id).toBe(panes[0].pane_id);
});
