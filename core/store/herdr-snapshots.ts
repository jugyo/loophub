import { db, now } from "../db.ts";
import type { HerdrSessionsWire } from "../serialize.ts";

// Single-row (id = 1) snapshot of running herdr sessions written by the worker sweep (#1665). See
// the herdr_session_snapshots table comment in db.ts for the column semantics.

export interface HerdrSessionSnapshot {
  snapshot: HerdrSessionsWire;
  captured_at: string;
}

interface HerdrSnapshotRow {
  snapshot: string;
  signature: string;
  captured_at: string;
}

// Whether recording changed the structural signature (so the caller emits a change event) and the
// timestamp stamped on this write. captured_at is refreshed every call, even when unchanged, so a
// healthy-but-idle worker never reads as stale (see recordHerdrSessionSnapshot).
export interface HerdrSnapshotRecord {
  changed: boolean;
  captured_at: string;
}

// The latest worker-written snapshot, or null when none has been written yet (worker never ran, or
// a fresh DB). The stored JSON is trusted: only recordHerdrSessionSnapshot writes it, from a
// core serializer.
export function getHerdrSessionSnapshot(): HerdrSessionSnapshot | null {
  const row = db
    .query(
      `SELECT snapshot, signature, captured_at FROM herdr_session_snapshots WHERE id = 1`,
    )
    .get() as HerdrSnapshotRow | undefined;
  if (!row) return null;
  return {
    snapshot: JSON.parse(row.snapshot) as HerdrSessionsWire,
    captured_at: row.captured_at,
  };
}

// Upsert the single snapshot row and report whether its structural signature changed. captured_at
// is always refreshed so a frozen timestamp means a stopped worker, not merely an unchanged herdr
// state; the signature comparison (which excludes volatile token usage — see
// herdrSnapshotSignature) decides whether a terminal.sessions_updated event should fire. Mirrors
// recordPullConflictState: record every tick, act only on a transition.
export function recordHerdrSessionSnapshot(
  snapshot: HerdrSessionsWire,
  signature: string,
): HerdrSnapshotRecord {
  const prev = db
    .query(`SELECT signature FROM herdr_session_snapshots WHERE id = 1`)
    .get() as { signature: string } | undefined;
  const capturedAt = now();
  db.query(
    `INSERT INTO herdr_session_snapshots (id, snapshot, signature, captured_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       snapshot = excluded.snapshot,
       signature = excluded.signature,
       captured_at = excluded.captured_at`,
  ).run(JSON.stringify(snapshot), signature, capturedAt);
  return { changed: prev?.signature !== signature, captured_at: capturedAt };
}
