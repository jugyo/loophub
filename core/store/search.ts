import { db } from "../db.ts";
import type { IssueRow } from "./issues.ts";

export interface SearchResultRow {
  kind: "issue" | "pull";
  number: number;
  title: string;
  state: "open" | "closed";
}

function grams(text: string, allSizes = false): string[] {
  const chars = Array.from(text.toLowerCase());
  const out = new Set<string>();
  const maxSize = Math.min(3, chars.length);
  const minSize = allSizes ? 1 : maxSize;
  for (let size = minSize; size <= maxSize; size++) {
    for (let i = 0; i <= chars.length - size; i++) {
      out.add(chars.slice(i, i + size).join(""));
    }
  }
  return [...out];
}

export function indexIssueSearch(
  issue: Pick<IssueRow, "id" | "title" | "body">,
) {
  db.run("DELETE FROM issue_search_grams WHERE issue_id = ?", [issue.id]);
  const indexedGrams = new Set([
    ...grams(issue.title, true),
    ...grams(issue.body, true),
  ]);
  for (const gram of indexedGrams) {
    db.run(
      "INSERT OR IGNORE INTO issue_search_grams(issue_id, gram) VALUES (?, ?)",
      [issue.id, gram],
    );
  }
}

export function searchIssuesAndPulls(
  repoId: number,
  query: string,
): SearchResultRow[] {
  const term = query.trim();
  if (!term) return [];
  const queryGrams = grams(term);
  const placeholders = queryGrams.map(() => "?").join(", ");
  return db
    .query(
      `SELECT i.kind, i.number, i.title, i.state
       FROM issue_search_grams search
       JOIN issues i ON i.id = search.issue_id
       WHERE search.gram IN (${placeholders}) AND i.repo_id = ?
       GROUP BY i.id
       HAVING COUNT(DISTINCT search.gram) = ?
          AND (instr(lower(i.title), ?) > 0 OR instr(lower(i.body), ?) > 0)
       ORDER BY i.updated_at DESC, i.number DESC`,
    )
    .all(
      ...queryGrams,
      repoId,
      queryGrams.length,
      term.toLowerCase(),
      term.toLowerCase(),
    ) as SearchResultRow[];
}
