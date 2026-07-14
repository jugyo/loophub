import { db, now } from "../db.ts";

export interface HerdrPaneRow {
  id: number;
  repo_id: number;
  launch_id: string;
  pane_id: string | null;
  session_name: string | null;
  display_name: string | null;
  origin: string | null;
  created_at: string;
  updated_at: string;
}

export interface HerdrPaneResourceRow {
  pane_id: number;
  resource_kind: string;
  resource_key: string;
  created_at: string;
}

function ensureHerdrPane(repoId: number, launchId: string): HerdrPaneRow {
  const t = now();
  db.run(
    `INSERT INTO herdr_panes
       (repo_id, launch_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo_id, launch_id) DO NOTHING`,
    [repoId, launchId, t, t],
  );
  return getHerdrPaneByLaunch(repoId, launchId) as HerdrPaneRow;
}

export function registerHerdrPane(input: {
  repoId: number;
  launchId: string;
  paneId?: string | null;
  sessionName?: string | null;
  displayName?: string | null;
  origin?: string | null;
}): HerdrPaneRow {
  const t = now();
  db.run(
    `INSERT INTO herdr_panes
       (repo_id, launch_id, pane_id, session_name, display_name, origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, launch_id) DO UPDATE SET
       pane_id = COALESCE(excluded.pane_id, herdr_panes.pane_id),
       session_name = COALESCE(excluded.session_name, herdr_panes.session_name),
       display_name = COALESCE(excluded.display_name, herdr_panes.display_name),
       origin = COALESCE(excluded.origin, herdr_panes.origin),
       updated_at = excluded.updated_at`,
    [
      input.repoId,
      input.launchId,
      input.paneId ?? null,
      input.sessionName ?? null,
      input.displayName ?? null,
      input.origin ?? null,
      t,
      t,
    ],
  );
  return getHerdrPaneByLaunch(input.repoId, input.launchId) as HerdrPaneRow;
}

export function linkHerdrPaneResource(input: {
  repoId: number;
  launchId: string;
  resourceKind: string;
  resourceKey: string;
}): HerdrPaneRow {
  const pane = ensureHerdrPane(input.repoId, input.launchId);
  db.run(
    `INSERT OR IGNORE INTO herdr_pane_resources
       (pane_id, resource_kind, resource_key, created_at)
     VALUES (?, ?, ?, ?)`,
    [pane.id, input.resourceKind, input.resourceKey, now()],
  );
  return pane;
}

export function getHerdrPaneByLaunch(
  repoId: number,
  launchId: string,
): HerdrPaneRow | null {
  return db
    .query(`SELECT * FROM herdr_panes WHERE repo_id = ? AND launch_id = ?`)
    .get(repoId, launchId) as HerdrPaneRow | null;
}

export function listHerdrPanesForResource(input: {
  repoId: number;
  resourceKind: string;
  resourceKey: string;
}): HerdrPaneRow[] {
  return db
    .query(
      `SELECT p.*
       FROM herdr_panes p
       JOIN herdr_pane_resources r ON r.pane_id = p.id
       WHERE p.repo_id = ? AND r.resource_kind = ? AND r.resource_key = ?
       ORDER BY p.created_at, p.id`,
    )
    .all(input.repoId, input.resourceKind, input.resourceKey) as HerdrPaneRow[];
}

export function listHerdrPanesByOrigin(
  repoId: number,
  origin: string,
): HerdrPaneRow[] {
  return db
    .query(
      `SELECT * FROM herdr_panes
       WHERE repo_id = ? AND origin = ?
       ORDER BY created_at, id`,
    )
    .all(repoId, origin) as HerdrPaneRow[];
}
