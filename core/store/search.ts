import { db } from "../db.ts";
import type { IssueRow } from "./issues.ts";

export interface SearchSnippetSegment {
  text: string;
  match: boolean;
}

export interface SearchSnippet {
  field: "title" | "body";
  segments: SearchSnippetSegment[];
}

export interface SearchResultRow {
  kind: "issue" | "pull";
  number: number;
  title: string;
  state: "open" | "closed";
  snippet: SearchSnippet | null;
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

// Relevance scoring (no FTS5 on node:sqlite): the gram index narrows candidates, then we score
// each match in JS. A match at a word boundary or as a whole word ranks above one buried inside a
// longer word (`crit` beats `critical`), and a title match outweighs the same match in the body.
// Like GitHub's best-match, recency is not folded into the score: newer issues only break ties
// between equal-relevance results (see the sort in searchIssuesAndPulls).
type MatchKind = "whole" | "boundary" | "substring" | "none";

const KIND_SCORE: Record<MatchKind, number> = {
  whole: 3,
  boundary: 2,
  substring: 1,
  none: 0,
};
const TITLE_WEIGHT = 3;
const BODY_WEIGHT = 1;
const SNIPPET_CONTEXT = 40;

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function matchKind(text: string, lowerTerm: string): MatchKind {
  const lower = text.toLowerCase();
  let best: MatchKind = "none";
  for (
    let i = lower.indexOf(lowerTerm);
    i >= 0;
    i = lower.indexOf(lowerTerm, i + 1)
  ) {
    const boundaryStart = !isWordChar(lower[i - 1]);
    const boundaryEnd = !isWordChar(lower[i + lowerTerm.length]);
    const kind: MatchKind =
      boundaryStart && boundaryEnd
        ? "whole"
        : boundaryStart || boundaryEnd
          ? "boundary"
          : "substring";
    if (KIND_SCORE[kind] > KIND_SCORE[best]) best = kind;
    if (best === "whole") break;
  }
  return best;
}

function buildSnippet(
  text: string,
  field: "title" | "body",
  lowerTerm: string,
): SearchSnippet | null {
  const lower = text.toLowerCase();
  const first = lower.indexOf(lowerTerm);
  if (first < 0) return null;

  const start = Math.max(0, first - SNIPPET_CONTEXT);
  const end = Math.min(text.length, first + lowerTerm.length + SNIPPET_CONTEXT);
  const window = text.slice(start, end);
  const windowLower = lower.slice(start, end);

  const segments: SearchSnippetSegment[] = [];
  if (start > 0) segments.push({ text: "…", match: false });
  let cursor = 0;
  for (
    let i = windowLower.indexOf(lowerTerm);
    i >= 0;
    i = windowLower.indexOf(lowerTerm, i + lowerTerm.length)
  ) {
    if (i > cursor)
      segments.push({ text: window.slice(cursor, i), match: false });
    segments.push({ text: window.slice(i, i + lowerTerm.length), match: true });
    cursor = i + lowerTerm.length;
  }
  if (cursor < window.length)
    segments.push({ text: window.slice(cursor), match: false });
  if (end < text.length) segments.push({ text: "…", match: false });

  return { field, segments };
}

interface CandidateRow {
  kind: "issue" | "pull";
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  updated_at: string;
}

export function searchIssuesAndPulls(
  repoId: number,
  query: string,
): SearchResultRow[] {
  const term = query.trim();
  if (!term) return [];
  const lowerTerm = term.toLowerCase();
  const queryGrams = grams(term);
  const placeholders = queryGrams.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT i.kind, i.number, i.title, i.body, i.state, i.updated_at
       FROM issue_search_grams search
       JOIN issues i ON i.id = search.issue_id
       WHERE search.gram IN (${placeholders}) AND i.repo_id = ?
         AND (i.kind != 'pull' OR NOT EXISTS (
           SELECT 1 FROM pulls p
           WHERE p.issue_id = i.id AND p.archived_at IS NOT NULL
         ))
       GROUP BY i.id
       HAVING COUNT(DISTINCT search.gram) = ?
          AND (instr(lower(i.title), ?) > 0 OR instr(lower(i.body), ?) > 0)`,
    )
    .all(
      ...queryGrams,
      repoId,
      queryGrams.length,
      lowerTerm,
      lowerTerm,
    ) as CandidateRow[];

  const scored = rows.map((row) => {
    const titleKind = matchKind(row.title, lowerTerm);
    const bodyKind = matchKind(row.body, lowerTerm);
    const relevance =
      KIND_SCORE[titleKind] * TITLE_WEIGHT + KIND_SCORE[bodyKind] * BODY_WEIGHT;
    const snippet =
      bodyKind !== "none"
        ? buildSnippet(row.body, "body", lowerTerm)
        : buildSnippet(row.title, "title", lowerTerm);
    const epoch = Date.parse(row.updated_at) || 0;
    return { row, relevance, epoch, snippet };
  });

  // Order by relevance only; recency is a tiebreak, not part of the score (GitHub best-match style).
  return scored
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        b.epoch - a.epoch ||
        b.row.number - a.row.number,
    )
    .map((entry) => ({
      kind: entry.row.kind,
      number: entry.row.number,
      title: entry.row.title,
      state: entry.row.state,
      snippet: entry.snippet,
    }));
}
