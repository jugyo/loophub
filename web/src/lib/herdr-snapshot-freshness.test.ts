import { describe, expect, it } from "vitest";
import {
  classifyHerdrSnapshotFreshness,
  HERDR_SNAPSHOT_STALE_MS,
} from "./herdr-snapshot-freshness";

const NOW = Date.parse("2026-07-19T00:00:10.000Z");

describe("classifyHerdrSnapshotFreshness", () => {
  it("reports missing when no snapshot has been written", () => {
    expect(classifyHerdrSnapshotFreshness(null, NOW)).toEqual({
      state: "missing",
    });
    expect(classifyHerdrSnapshotFreshness(undefined, NOW)).toEqual({
      state: "missing",
    });
  });

  it("reports missing for an unparseable timestamp", () => {
    expect(classifyHerdrSnapshotFreshness("not-a-date", NOW)).toEqual({
      state: "missing",
    });
  });

  it("reports fresh within the stale threshold", () => {
    const capturedAt = new Date(NOW - 3000).toISOString();
    expect(classifyHerdrSnapshotFreshness(capturedAt, NOW)).toEqual({
      state: "fresh",
      ageMs: 3000,
    });
  });

  it("reports stale once the snapshot ages past the threshold", () => {
    const capturedAt = new Date(NOW - HERDR_SNAPSHOT_STALE_MS).toISOString();
    expect(classifyHerdrSnapshotFreshness(capturedAt, NOW)).toEqual({
      state: "stale",
      ageMs: HERDR_SNAPSHOT_STALE_MS,
    });
  });

  it("clamps a future captured_at (clock skew) to fresh, not stale", () => {
    const capturedAt = new Date(NOW + 5000).toISOString();
    expect(classifyHerdrSnapshotFreshness(capturedAt, NOW)).toEqual({
      state: "fresh",
      ageMs: 0,
    });
  });
});
