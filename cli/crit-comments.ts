// Map `crit comments --json` output into a single LoopHub review submission (#1654).
//
// crit's official `crit comments --json` is the source of truth for resolved / scope / round
// semantics: it prints a flat array of the *unresolved* comments only. We do not parse crit's
// own review.json — this mapping is deliberately CLI-side and dependency-free (no core module,
// no DB) so it stays trivially unit-testable and never re-derives what crit already computed.

/** One entry from `crit comments --json` (flat, unresolved-only). */
export interface CritComment {
  // "review" (general feedback), "file" (whole file), or "line" (a line/range).
  scope?: string;
  // Present for file/line comments; absent for review-level comments.
  path?: string;
  // 0 for review/file-level comments; the 1-indexed start line for line comments.
  start_line?: number;
  end_line?: number;
  body?: string;
  author?: string;
}

/** A review to submit via `reviews.create`, or null when there is nothing to submit. */
export interface CritReviewSubmission {
  body: string;
  comments: { path: string; line?: number; body: string }[];
}

/**
 * Parse `crit comments --json` stdout into a comment array. An empty review (no unresolved
 * comments, or no review file at all) prints the literal `null`, not `[]`, so guard both — and
 * treat any non-array (or unparseable output) as "no comments".
 */
export function parseCritComments(stdout: string): CritComment[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? (parsed as CritComment[]) : [];
}

/**
 * Fold unresolved crit comments into a single REQUEST_CHANGES review:
 * - review-level comments (`scope: "review"`, or no path) collapse into the review body;
 * - file/line comments (they carry a path; `start_line: 0` means file-level) become review
 *   comments, keeping the line number only for line comments.
 * Returns null when there are no unresolved comments (nothing happened → post nothing).
 */
export function buildCritReview(
  comments: CritComment[],
): CritReviewSubmission | null {
  if (comments.length === 0) return null;
  const bodyParts: string[] = [];
  const lineComments: { path: string; line?: number; body: string }[] = [];
  for (const c of comments) {
    const body = (c.body ?? "").trim();
    // Review-level feedback has no file to attach to; fold it into the body.
    if (c.scope === "review" || !c.path) {
      if (body) bodyParts.push(body);
      continue;
    }
    // File-level comments carry start_line 0 (whole file); drop the line so it stays file-scoped.
    const line = c.start_line && c.start_line > 0 ? c.start_line : undefined;
    lineComments.push({ path: c.path, line, body });
  }
  return { body: bodyParts.join("\n\n"), comments: lineComments };
}
