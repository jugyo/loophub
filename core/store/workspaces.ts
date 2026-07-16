import { db, now } from "../db.ts";

export interface Workspace {
  id: number;
  repo_id: number;
  branch: string;
  created_at: string;
  archived_at: string | null;
}

export function createWorkspace(repoId: number, branch: string): Workspace {
  return db
    .query(
      `INSERT INTO workspaces (repo_id, branch, created_at)
       VALUES (?, ?, ?) RETURNING *`,
    )
    .get(repoId, branch, now()) as Workspace;
}

export function getWorkspace(repoId: number, branch: string): Workspace | null {
  return db
    .query(`SELECT * FROM workspaces WHERE repo_id = ? AND branch = ?`)
    .get(repoId, branch) as Workspace | null;
}

export function listWorkspaces(repoId: number): Workspace[] {
  return db
    .query(
      `SELECT * FROM workspaces
       WHERE repo_id = ? AND archived_at IS NULL
       ORDER BY created_at, id`,
    )
    .all(repoId) as Workspace[];
}

export function setWorkspaceArchived(
  repoId: number,
  branch: string,
  archived: boolean,
): void {
  db.run(
    `UPDATE workspaces SET archived_at = ? WHERE repo_id = ? AND branch = ?`,
    [archived ? now() : null, repoId, branch],
  );
}
