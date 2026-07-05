import { databaseSize, repoCounts, tableRowCounts } from "./shared.ts";

// ===== stats (#587) =====
export const stats = {
  // Database statistics for the web /stats page: row counts for every user table,
  // the SQLite file's on-disk size (WAL included), and per-repo issue/PR tallies.
  // Pure read-only aggregation (core/stats.ts); the web renders the numbers as-is.
  get() {
    return {
      database: databaseSize(),
      tables: tableRowCounts(),
      repos: repoCounts(),
    };
  },
};
