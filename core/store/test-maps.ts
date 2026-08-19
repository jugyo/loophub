import { db, now } from "../db.ts";

// #348: a test map is the listing of what a PR's tests verify — the tests read on their own,
// without the diff around them. One row is one generation, keyed by the PR's issues row id and
// stamped with the head its code excerpts were read from.
//
// `document` holds the map as JSON (core/test-map-document.ts). It is stored as text and parsed by
// the layer above, so the store stays a plain row reader/writer.
export interface PrTestMap {
  id: number;
  issue_id: number;
  head_sha: string;
  document: string;
  created_by: string | null;
  created_at: string;
}

/**
 * Record a generated test map for a PR at `headSha`.
 *
 * Append-only: a regeneration adds a row rather than replacing the previous one, so a map a reader
 * has open is never rewritten under them, and the excerpts written against earlier heads stay
 * attributable to those heads.
 */
export function createPrTestMap(input: {
  issueId: number;
  headSha: string;
  document: string;
  createdBy?: string | null;
}): PrTestMap {
  return db
    .query(
      `INSERT INTO pr_test_maps (issue_id, head_sha, document, created_by, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.issueId,
      input.headSha,
      input.document,
      input.createdBy ?? null,
      now(),
    ) as PrTestMap;
}

/** The newest test map generated for a PR, or null when none has been. */
export function latestPrTestMap(issueId: number): PrTestMap | null {
  return (
    (db
      .query(
        `SELECT * FROM pr_test_maps WHERE issue_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(issueId) as PrTestMap) ?? null
  );
}
