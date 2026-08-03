// Database statistics (#587): row counts for every user table, the SQLite file's
// on-disk size (WAL included), and per-repo issue/PR tallies. Pure read-only
// aggregation over the DB and its files; service.ts composes these into the
// `stats.get` procedure and the web UI renders the numbers as-is.
import { statSync } from "node:fs";
import { dbPath } from "./config.ts";
import { db } from "./db.ts";

export interface TableCount {
  name: string;
  rows: number;
}

export interface DatabaseSize {
  path: string;
  size_bytes: number;
  /** Size of the `-wal` companion file, or null when none exists (e.g. after a full checkpoint). */
  wal_size_bytes: number | null;
  /** size_bytes + wal_size_bytes — the DB's real on-disk footprint under WAL journaling. */
  total_size_bytes: number;
}

export interface RepoCounts {
  full_name: string;
  issues: { open: number; closed: number };
  pulls: { open: number; merged: number; closed: number };
}

/** Row counts for every user table, name-ordered. */
export function tableRowCounts(): TableCount[] {
  const tables = db
    .query(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as { name: string }[];
  // Names come from sqlite_master, not user input; the quote-doubling keeps the
  // identifier well-formed even if a table name ever contains a double quote.
  return tables.map(({ name }) => ({
    name,
    rows: (
      db
        .query(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`)
        .get() as { n: number }
    ).n,
  }));
}

/** The SQLite file's on-disk size, WAL companion included. */
export function databaseSize(): DatabaseSize {
  const path = dbPath();
  const size = statSync(path).size;
  const wal = statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? null;
  return {
    path,
    size_bytes: size,
    wal_size_bytes: wal,
    total_size_bytes: size + (wal ?? 0),
  };
}

/**
 * Per-repo issue and PR tallies. A merged PR is counted as merged only: its issues
 * row is also state='closed', so "closed" is restricted to closed-without-merge,
 * and "open" excludes merged rows in case a merged PR is ever reopened.
 */
export function repoCounts(): RepoCounts[] {
  const rows = db
    .query(
      `SELECT r.full_name AS full_name,
         SUM(CASE WHEN i.kind = 'issue' AND i.state = 'open' THEN 1 ELSE 0 END) AS issues_open,
         SUM(CASE WHEN i.kind = 'issue' AND i.state = 'closed' THEN 1 ELSE 0 END) AS issues_closed,
         SUM(CASE WHEN i.kind = 'pull' AND p.archived_at IS NULL AND i.state = 'open' AND COALESCE(p.merged, 0) = 0 THEN 1 ELSE 0 END) AS pulls_open,
         SUM(CASE WHEN i.kind = 'pull' AND p.archived_at IS NULL AND p.merged = 1 THEN 1 ELSE 0 END) AS pulls_merged,
         SUM(CASE WHEN i.kind = 'pull' AND p.archived_at IS NULL AND i.state = 'closed' AND COALESCE(p.merged, 0) = 0 THEN 1 ELSE 0 END) AS pulls_closed
       FROM repos r
       LEFT JOIN issues i ON i.repo_id = r.id
       LEFT JOIN pulls p ON p.issue_id = i.id
       GROUP BY r.id
       ORDER BY r.full_name`,
    )
    .all() as {
    full_name: string;
    issues_open: number;
    issues_closed: number;
    pulls_open: number;
    pulls_merged: number;
    pulls_closed: number;
  }[];
  return rows.map((r) => ({
    full_name: r.full_name,
    issues: { open: r.issues_open, closed: r.issues_closed },
    pulls: {
      open: r.pulls_open,
      merged: r.pulls_merged,
      closed: r.pulls_closed,
    },
  }));
}
