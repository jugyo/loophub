// Classify how fresh the worker-owned herdr snapshot is (#1665). terminal/sessions is a pure DB
// read of the snapshot lh-worker writes every ~3s, so a frozen captured_at means the worker
// stopped, not that herdr is idle (the worker refreshes captured_at every tick regardless of
// change). Surfacing that staleness is deliberate: the acceptance criterion forbids hiding a
// stopped worker behind an automatic herdr fallback.

// Worker sweeps every DEFAULT_HERDR_SWEEP_MS (3s). Allow several missed ticks before calling the
// snapshot stale so a slow tick or clock skew does not flap the warning.
export const HERDR_SNAPSHOT_STALE_MS = 15_000;

export type HerdrSnapshotFreshness =
  | { state: "missing" }
  | { state: "fresh"; ageMs: number }
  | { state: "stale"; ageMs: number };

// capturedAt is the wire's captured_at (ISO string, or null/undefined when no snapshot has ever
// been written). nowMs is injected so this stays pure and unit-testable. A captured_at in the
// future (clock skew) or unparseable value is treated as fresh (ageMs clamped to >= 0) rather than
// falsely stale.
export function classifyHerdrSnapshotFreshness(
  capturedAt: string | null | undefined,
  nowMs: number,
): HerdrSnapshotFreshness {
  if (!capturedAt) return { state: "missing" };
  const parsed = Date.parse(capturedAt);
  if (!Number.isFinite(parsed)) return { state: "missing" };
  const ageMs = Math.max(0, nowMs - parsed);
  return ageMs >= HERDR_SNAPSHOT_STALE_MS
    ? { state: "stale", ageMs }
    : { state: "fresh", ageMs };
}
