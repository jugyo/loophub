import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, revParse } from "../../core/git.ts";

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

test("startEventTail forwards out-of-process DB writes to the in-process hub", async () => {
  const { startEventTail } = await import("./events.ts");
  const { subscribe } = await import("../../core/event-hub.ts");
  const { db, now } = await import("../../core/db.ts");

  const got: number[] = [];
  const unsub = subscribe((e) => got.push(e.id));
  const stop = startEventTail(20);

  // Simulate another process writing an event: insert directly, bypassing publishEvent.
  const row = db
    .query(
      `INSERT INTO events (repo_id, type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(repoId, "issue.opened", "cli", JSON.stringify({ number: 99 }), now()) as { id: number };

  await new Promise((r) => setTimeout(r, 80)); // let a poll tick run
  stop();
  unsub();

  expect(got).toContain(row.id);
});

test("startPullSweep fires pull_request.updated on head SHA change, no-ops when unchanged", async () => {
  const { startPullSweep } = await import("./events.ts");

  // Real git repo so revParse(local_path, head_ref) resolves a moving branch head.
  const repoPath = mkdtempSync(join(tmpdir(), "lh-sweep-"));
  await git(repoPath, ["init", "-q", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "t@t.local"]);
  await git(repoPath, ["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "f.txt"), "base\n");
  await git(repoPath, ["add", "-A"]);
  await git(repoPath, ["commit", "-qm", "base"]);
  await git(repoPath, ["checkout", "-q", "-b", "loophub/issue-x"]);
  writeFileSync(join(repoPath, "f.txt"), "c1\n");
  await git(repoPath, ["commit", "-qam", "c1"]);

  const repo = S.createRepo("me/sweep", repoPath);
  const pull = S.createIssue(repo.id, "pull", "PR", "", "me");
  S.createPull(pull.id, "loophub/issue-x", "main", null); // head_sha unset -> first sweep records it

  const countUpdates = () =>
    S.listEvents(0, repo.id, 100).filter((e: any) => e.type === "pull_request.updated").length;

  const stop = startPullSweep(20);
  try {
    await new Promise((r) => setTimeout(r, 60)); // first tick records baseline, emits nothing
    expect(countUpdates()).toBe(0);
    expect(S.getPull(pull.id).head_sha).toBe(await revParse(repoPath, "loophub/issue-x"));

    // New commit moves the branch head -> next sweep should emit exactly one update.
    writeFileSync(join(repoPath, "f.txt"), "c2\n");
    await git(repoPath, ["commit", "-qam", "c2"]);
    await new Promise((r) => setTimeout(r, 60));
    expect(countUpdates()).toBe(1);

    // No further commits -> unchanged head is a no-op (no new DB write).
    await new Promise((r) => setTimeout(r, 60));
    expect(countUpdates()).toBe(1);
  } finally {
    stop();
  }

  // After stop(), a moving head no longer produces events (interval cleared).
  writeFileSync(join(repoPath, "f.txt"), "c3\n");
  await git(repoPath, ["commit", "-qam", "c3"]);
  await new Promise((r) => setTimeout(r, 60));
  expect(countUpdates()).toBe(1);

  rmSync(repoPath, { recursive: true, force: true });
});
