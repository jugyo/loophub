import { db, now } from "../db.ts";

// ---- review notes (#204, PR-independent since #216) ----
// A note attaches a short description to one file's diff (base_sha -> commit_sha). Its identity is
// the range + path within a repo; issue_id is an OPTIONAL link to a PR (the kind='pull' issues row),
// NULL for a PR-independent note. The diff range lives on the row, so a note stands on its own
// without a PR. Multiple notes per file are allowed.
export interface ReviewNoteInput {
  repoId: number;
  issueId?: number | null;
  baseSha: string;
  commitSha: string;
  path: string;
  body: string;
  author: string;
}

export function createReviewNote(input: ReviewNoteInput): any {
  const t = now();
  return db
    .query(
      `INSERT INTO review_notes
        (repo_id, issue_id, base_sha, commit_sha, path, body, author, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      input.repoId,
      input.issueId ?? null,
      input.baseSha,
      input.commitSha,
      input.path,
      input.body,
      input.author,
      t,
      t,
    );
}

export function getReviewNoteById(id: number): any {
  return db.query(`SELECT * FROM review_notes WHERE id = ?`).get(id);
}

// List a repo's notes, newest first. All filters are optional: issueId narrows to one PR's notes,
// baseSha/commitSha to a single diff range, path to a single file. With no filters it returns every
// note in the repo. Filtering by (baseSha, commitSha, path) is how a consumer fetches the notes for
// a bare commit range with no PR.
export function listReviewNotes(
  repoId: number,
  opts: {
    issueId?: number;
    path?: string;
    baseSha?: string;
    commitSha?: string;
  } = {},
): any[] {
  const conds = ["repo_id = ?"];
  const params: any[] = [repoId];
  if (opts.issueId !== undefined) {
    conds.push("issue_id = ?");
    params.push(opts.issueId);
  }
  if (opts.path !== undefined) {
    conds.push("path = ?");
    params.push(opts.path);
  }
  if (opts.baseSha !== undefined) {
    conds.push("base_sha = ?");
    params.push(opts.baseSha);
  }
  if (opts.commitSha !== undefined) {
    conds.push("commit_sha = ?");
    params.push(opts.commitSha);
  }
  return db
    .query(
      `SELECT * FROM review_notes WHERE ${conds.join(" AND ")}
       ORDER BY created_at DESC, id DESC`,
    )
    .all(...params);
}

export function updateReviewNote(id: number, body: string): any {
  db.run(`UPDATE review_notes SET body = ?, updated_at = ? WHERE id = ?`, [
    body,
    now(),
    id,
  ]);
  return getReviewNoteById(id);
}

export function deleteReviewNote(id: number): void {
  db.run(`DELETE FROM review_notes WHERE id = ?`, [id]);
}
