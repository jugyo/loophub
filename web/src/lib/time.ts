// Compact relative-time formatting for dashboard row metadata ("3h ago").
// Pure + dependency-free so it is unit-testable.

const UNITS: [limit: number, secs: number, label: string][] = [
  [60, 1, "s"],
  [3600, 60, "m"],
  [86400, 3600, "h"],
  [2592000, 86400, "d"],
  [31536000, 2592000, "mo"],
  [Infinity, 31536000, "y"],
];

/** Format an ISO timestamp as a short relative string like "3h ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Math.max(0, Math.floor((now - then) / 1000));
  if (diff < 5) return "just now";
  for (const [limit, secs, label] of UNITS) {
    if (diff < limit) return `${Math.floor(diff / secs)}${label} ago`;
  }
  return "";
}
