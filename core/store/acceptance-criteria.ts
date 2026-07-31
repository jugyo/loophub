import { db, now } from "../db.ts";

export interface AcceptanceCriterionRow {
  id: number;
  issue_id: number;
  number: number;
  ordinal: number;
  text: string;
  enabled: number; // 1 = enabled, 0 = disabled
  created_at: string;
}

// Append a criterion at the end, enabled. `ordinal` is the mutable display position; `number` and
// the grade-FK `id` are both monotonic identities and are never reused or reordered.
export function addAcceptanceCriterion(
  issueId: number,
  text: string,
): AcceptanceCriterionRow {
  const next = db
    .query(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal,
                COALESCE(MAX(number), 0) + 1 AS number
         FROM acceptance_criteria WHERE issue_id = ?`,
    )
    .get(issueId) as { ordinal: number; number: number };
  return db
    .query(
      `INSERT INTO acceptance_criteria (issue_id, number, ordinal, text, enabled, created_at)
       VALUES (?, ?, ?, ?, 1, ?) RETURNING *`,
    )
    .get(
      issueId,
      next.number,
      next.ordinal,
      text,
      now(),
    ) as AcceptanceCriterionRow;
}

// All criteria for an issue in display order (ordinal, then id as a stable tiebreaker). Includes
// disabled rows so `lh issue ac list` can show what is available to re-enable; callers that want
// only the rubric (issue view) filter on `enabled`.
export function listAcceptanceCriteria(
  issueId: number,
): AcceptanceCriterionRow[] {
  return db
    .query(
      `SELECT * FROM acceptance_criteria WHERE issue_id = ? ORDER BY ordinal, id`,
    )
    .all(issueId) as AcceptanceCriterionRow[];
}

export function getAcceptanceCriterion(
  id: number,
): AcceptanceCriterionRow | null {
  return db
    .query(`SELECT * FROM acceptance_criteria WHERE id = ?`)
    .get(id) as AcceptanceCriterionRow | null;
}

export function getAcceptanceCriterionByNumber(
  issueId: number,
  number: number,
): AcceptanceCriterionRow | null {
  return db
    .query(
      `SELECT * FROM acceptance_criteria WHERE issue_id = ? AND number = ?`,
    )
    .get(issueId, number) as AcceptanceCriterionRow | null;
}

// Criteria are never deleted — identity (id) and past grades must survive. An unwanted criterion is
// disabled here and can be re-enabled later; the FK from a future grade can never dangle.
export function setAcceptanceCriterionEnabled(
  id: number,
  enabled: boolean,
): void {
  db.run(`UPDATE acceptance_criteria SET enabled = ? WHERE id = ?`, [
    enabled ? 1 : 0,
    id,
  ]);
}

// Reorder is an ordinal rewrite scoped to one issue; ids stay fixed, so grades stay attached across
// a reorder. The caller validates that `orderedIds` is a permutation of the issue's criterion ids.
export function reorderAcceptanceCriteria(
  issueId: number,
  orderedIds: number[],
): void {
  db.transaction(() => {
    orderedIds.forEach((id, index) => {
      db.run(
        `UPDATE acceptance_criteria SET ordinal = ? WHERE id = ? AND issue_id = ?`,
        [index + 1, id, issueId],
      );
    });
  });
}
