import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before herdr-cleanup.ts -> shared.ts -> store.ts -> db.ts runs its import-time
// setup (see AGENTS.md). The functions under test are pure, but importing the module still opens
// the DB through that chain.
const HOME = mkdtempSync(join(tmpdir(), "lh-herdr-cleanup-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let C: typeof import("./herdr-cleanup.ts");
beforeAll(async () => {
  C = await import("./herdr-cleanup.ts");
});
afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

// closedPullAgentEligibleAt / timestampPlus are the pure grace/eligibility calculation behind
// cleanupClosedPullDevAgents (#926): they decide *when* a closed/merged PR's dev agent becomes
// eligible for cleanup, independently of any herdr/DB side effects. The end-to-end wiring is
// covered by the integration tests in core/herdr-sessions-service.test.ts.

type PrRow = Parameters<
  typeof import("./herdr-cleanup.ts").closedPullAgentEligibleAt
>[0];
type Pull = Parameters<
  typeof import("./herdr-cleanup.ts").closedPullAgentEligibleAt
>[1];

const prRow = (over: Partial<PrRow>): PrRow =>
  ({ state: "open", closed_at: null, ...over }) as PrRow;
const pull = (over: Partial<Pull>): Pull =>
  ({ merged: 0, merged_at: null, ...over }) as Pull;

test("closedPullAgentEligibleAt prefers merged_at for a merged PR", () => {
  expect(
    C.closedPullAgentEligibleAt(
      prRow({ state: "closed", closed_at: "2026-07-18T00:00:00Z" }),
      pull({ merged: 1, merged_at: "2026-07-18T01:00:00Z" }),
    ),
  ).toBe("2026-07-18T01:00:00Z");
});

test("closedPullAgentEligibleAt uses closed_at for a closed-but-unmerged PR", () => {
  expect(
    C.closedPullAgentEligibleAt(
      prRow({ state: "closed", closed_at: "2026-07-18T00:00:00Z" }),
      pull({ merged: 0 }),
    ),
  ).toBe("2026-07-18T00:00:00Z");
});

test("closedPullAgentEligibleAt returns null for an open, unmerged PR", () => {
  expect(C.closedPullAgentEligibleAt(prRow({ state: "open" }), pull({}))).toBe(
    null,
  );
});

test("timestampPlus adds the grace window to a valid timestamp", () => {
  expect(C.timestampPlus("2026-07-18T00:00:00Z", 60 * 60 * 1000)).toBe(
    Date.parse("2026-07-18T01:00:00Z"),
  );
});

test("timestampPlus returns null for a null or unparseable value", () => {
  expect(C.timestampPlus(null, 1000)).toBe(null);
  expect(C.timestampPlus("not-a-date", 1000)).toBe(null);
});
