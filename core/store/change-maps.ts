import { db, now } from "../db.ts";

// #344: a change map is the structured, top-down account of everything a PR changed — the map a
// reader starts from before descending into individual diffs. One row is one generation, keyed by
// the PR's issues row id and stamped with the head it was written against.
//
// `document` holds the map as JSON (core/change-map-document.ts). It is stored as text and parsed
// by the layer above, so the store stays a plain row reader/writer.
export interface PrChangeMap {
  id: number;
  issue_id: number;
  head_sha: string;
  document: string;
  created_by: string | null;
  created_at: string;
}

/**
 * Record a generated change map for a PR at `headSha`.
 *
 * Append-only: a regeneration adds a row rather than replacing the previous one, so a map a reader
 * has open is never rewritten under them, and the maps written for earlier heads stay attributable
 * to those heads.
 */
export function createPrChangeMap(input: {
  issueId: number;
  headSha: string;
  document: string;
  createdBy?: string | null;
}): PrChangeMap {
  return db
    .query(
      `INSERT INTO pr_change_maps (issue_id, head_sha, document, created_by, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.issueId,
      input.headSha,
      input.document,
      input.createdBy ?? null,
      now(),
    ) as PrChangeMap;
}

/** The newest change map generated for a PR, or null when none has been. */
export function latestPrChangeMap(issueId: number): PrChangeMap | null {
  return (
    (db
      .query(
        `SELECT * FROM pr_change_maps WHERE issue_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(issueId) as PrChangeMap) ?? null
  );
}
