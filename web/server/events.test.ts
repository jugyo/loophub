import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the DB before store.ts -> db.ts runs its import-time setup.
const HOME = mkdtempSync(join(tmpdir(), "lh-events-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let subscribeEvents: typeof import("./events.ts").subscribeEvents;
let S: typeof import("../../core/store.ts");
let repoId: number;

beforeAll(async () => {
  ({ subscribeEvents } = await import("./events.ts"));
  S = await import("../../core/store.ts");
  const repo = S.createRepo("me/proj", "/tmp/proj");
  repoId = repo.id;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("replays events since the cursor, then delivers live events, then stops on unsubscribe", () => {
  S.emitEvent(repoId, "issue.opened", "me", { number: 1 });
  S.emitEvent(repoId, "issue.opened", "me", { number: 2 });

  const got: number[] = [];
  const unsub = subscribeEvents({ since: 0, repo: "me/proj" }, (n) => {
    expect(n.jsonrpc).toBe("2.0");
    expect(n.method).toBe("events/notify");
    got.push(n.params.id);
  });

  // both past events replayed
  expect(got.length).toBe(2);

  // a live event is delivered
  const live = S.emitEvent(repoId, "issue.closed", "me", { number: 1 }) as any;
  expect(got).toContain(live.id);
  const afterLive = got.length;

  unsub();
  S.emitEvent(repoId, "issue.opened", "me", { number: 3 });
  expect(got.length).toBe(afterLive); // nothing delivered after unsubscribe
});

test("since cursor skips already-seen events on replay", () => {
  const all = S.listEvents(0, repoId, 100);
  const lastId = all[all.length - 1].id;
  const got: number[] = [];
  const unsub = subscribeEvents({ since: lastId, repo: "me/proj" }, (n) => got.push(n.params.id));
  unsub();
  // every replayed id is strictly greater than the cursor
  expect(got.every((id) => id > lastId)).toBe(true);
});

test("an unknown repo filter replays nothing", () => {
  const got: number[] = [];
  const unsub = subscribeEvents({ since: 0, repo: "no/such" }, (n) => got.push(n.params.id));
  unsub();
  expect(got).toEqual([]);
});
