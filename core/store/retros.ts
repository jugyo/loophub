import { db, now } from "../db.ts";

// ---- retros ----
export interface RetroInput {
  repoId: number;
  issueId: number | null;
  prId: number | null;
  sessionId: string | null;
  rubricJson: string;
  findingsJson: string;
  status?: string;
  redacted?: boolean;
  redactRuleset?: string | null;
}

export function createRetro(input: RetroInput): any {
  const t = now();
  return db
    .query(
      `INSERT INTO retros
        (repo_id, issue_id, pr_id, session_id, rubric_json, findings_json,
         status, redacted, redact_ruleset, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.repoId,
      input.issueId,
      input.prId,
      input.sessionId,
      input.rubricJson,
      input.findingsJson,
      input.status ?? "draft",
      input.redacted ? 1 : 0,
      input.redactRuleset ?? null,
      t,
      t,
    );
}

export function getRetroById(id: number): any {
  return db.query(`SELECT * FROM retros WHERE id = ?`).get(id);
}

export function listRetros(
  repoId: number,
  opts: { prId?: number | null; status?: string } = {},
): any[] {
  const conds = ["repo_id = ?"];
  const params: any[] = [repoId];
  if (opts.prId != null) {
    conds.push("pr_id = ?");
    params.push(opts.prId);
  }
  if (opts.status) {
    conds.push("status = ?");
    params.push(opts.status);
  }
  return db
    .query(`SELECT * FROM retros WHERE ${conds.join(" AND ")} ORDER BY id DESC`)
    .all(...params);
}

// Backfill targets: merged PRs in a repo with no retro row yet (design §5.1 —
// "retro 済みかは retros 行の有無で判定"), newest merge first.
export function mergedPullsWithoutRetro(repoId: number, limit: number): any[] {
  return db
    .query(
      `SELECT i.*, p.merged_at
       FROM issues i
       JOIN pulls p ON p.issue_id = i.id
       WHERE i.repo_id = ? AND i.kind = 'pull' AND p.merged = 1
         AND NOT EXISTS (SELECT 1 FROM retros rt WHERE rt.pr_id = i.id)
       ORDER BY COALESCE(p.merged_at, i.updated_at) DESC, i.number DESC
       LIMIT ?`,
    )
    .all(repoId, limit);
}
