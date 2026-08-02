import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { HerdrSessionsWire } from "../serialize.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-herdr-snapshot-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("../store.ts");
let C: typeof import("./herdr-cleanup.ts");
let svc: typeof import("../service.ts");

beforeAll(async () => {
  S = await import("../store.ts");
  C = await import("./herdr-cleanup.ts");
  svc = await import("../service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function wire(status: string): HerdrSessionsWire {
  return {
    repos: [
      {
        repo: "me/app",
        session_name: "me-app-abc",
        agents: [
          {
            id: "p1",
            name: "dev #1",
            status,
            pull: 12,
            pull_closed: false,
            focusable: true,
          },
        ],
        pull_workspaces: [{ pull: 12, pane_id: "p1", status }],
        issue_workspaces: [],
      },
    ],
    running_repos: ["me/app"],
  };
}

// Same repo as wire(), but this tick's `herdr agent list` capture failed for it: the sweep reports
// the repo instead of dropping its group, which is what "no agents" would look like.
function captureFailedWire(): HerdrSessionsWire {
  return {
    repos: [],
    running_repos: ["me/app"],
    capture_failed_repos: ["me/app"],
  };
}

function terminalUpdateEvents(): number {
  return S.listEvents(0, null, 1000).filter(
    (e) => e.type === "terminal.sessions_updated",
  ).length;
}

test("getHerdrSessionSnapshot returns null before any snapshot is written", () => {
  expect(S.getHerdrSessionSnapshot()).toBeNull();
});

test("terminal.sessions degrades to an empty list with captured_at: null before any snapshot", () => {
  // Must run before the sweep test below populates the single snapshot row. A stopped/never-run
  // worker leaves no snapshot, and the RPC surfaces that as captured_at: null (staleness) instead
  // of an automatic herdr fallback (#1665).
  expect(svc.terminal.sessions()).toEqual({ repos: [], captured_at: null });
});

test("snapshot sweep persists the wire and emits only on a signature change", async () => {
  let current = wire("working");
  const sweep = () => Promise.resolve(current);

  const first = await C.snapshotHerdrSessionsImpl({ sweep });
  expect(first.changed).toBe(true);
  expect(first.repos).toBe(1);
  expect(terminalUpdateEvents()).toBe(1);

  const stored = S.getHerdrSessionSnapshot();
  expect(stored?.snapshot).toEqual(current);
  expect(stored?.captured_at).toBe(first.captured_at);

  // Same herdr state again -> captured_at refreshes but no new event.
  const second = await C.snapshotHerdrSessionsImpl({ sweep });
  expect(second.changed).toBe(false);
  expect(terminalUpdateEvents()).toBe(1);
  expect(S.getHerdrSessionSnapshot()?.captured_at).toBe(second.captured_at);

  // Status flips -> event fires again.
  current = wire("idle");
  const third = await C.snapshotHerdrSessionsImpl({ sweep });
  expect(third.changed).toBe(true);
  expect(terminalUpdateEvents()).toBe(2);
  expect(S.getHerdrSessionSnapshot()?.snapshot).toEqual(wire("idle"));
});

test("a failed per-repo capture keeps the last known agents and says so (#2142)", async () => {
  let current = wire("working");
  const sweep = () => Promise.resolve(current);

  const captured = await C.snapshotHerdrSessionsImpl({ sweep });
  expect(captured.capture_failed_repos).toBe(0);
  const capturedAt = captured.captured_at;
  const eventsBefore = terminalUpdateEvents();

  // Capture fails: the repo's agents survive, tagged with when they were last seen, and the
  // failure itself is named on the wire rather than looking like an idle repo.
  current = captureFailedWire();
  const failed = await C.snapshotHerdrSessionsImpl({ sweep });
  expect(failed.capture_failed_repos).toBe(1);
  expect(failed.repos).toBe(1);
  expect(failed.changed).toBe(true);
  const stale = S.getHerdrSessionSnapshot()?.snapshot;
  expect(stale?.capture_failed_repos).toEqual(["me/app"]);
  expect(stale?.repos[0].agents.map((a) => a.id)).toEqual(["p1"]);
  expect(stale?.repos[0].stale_since).toBe(capturedAt);
  expect(terminalUpdateEvents()).toBe(eventsBefore + 1);

  // Still failing: stale_since stays pinned to the last successful capture, so the signature is
  // unchanged and a repo that keeps failing does not emit an event every tick.
  const stillFailing = await C.snapshotHerdrSessionsImpl({ sweep });
  expect(stillFailing.changed).toBe(false);
  expect(S.getHerdrSessionSnapshot()?.snapshot.repos[0].stale_since).toBe(
    capturedAt,
  );
  expect(terminalUpdateEvents()).toBe(eventsBefore + 1);

  // Recovered: the fresh group replaces the carried-over one, tag and failure list gone.
  current = wire("working");
  const recovered = await C.snapshotHerdrSessionsImpl({ sweep });
  expect(recovered.capture_failed_repos).toBe(0);
  expect(recovered.changed).toBe(true);
  expect(S.getHerdrSessionSnapshot()?.snapshot).toEqual(wire("working"));
});

test("a repo that never captured successfully is reported without inventing agents", async () => {
  const sweep = () =>
    Promise.resolve<HerdrSessionsWire>({
      repos: [],
      running_repos: ["me/other"],
      capture_failed_repos: ["me/other"],
    });

  const result = await C.snapshotHerdrSessionsImpl({ sweep });
  expect(result.capture_failed_repos).toBe(1);
  expect(result.repos).toBe(0);
  expect(svc.terminal.sessions().capture_failed_repos).toEqual(["me/other"]);
});
