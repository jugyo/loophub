import { db, now } from "../db.ts";

export interface HerdrPaneRow {
  id: number;
  repo_id: number;
  launch_id: string;
  pane_id: string | null;
  session_name: string | null;
  display_name: string | null;
  origin: string | null;
  lifecycle_managed: number;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HerdrPaneResourceRow {
  pane_id: number;
  resource_kind: string;
  resource_key: string;
  created_at: string;
}

export interface HerdrPaneClaimRow {
  id: number;
  pane_id: number;
  resource_kind: string;
  resource_key: string;
  purpose: string;
  created_at: string;
  released_at: string | null;
}

export interface HerdrPaneClaimRelease {
  released: HerdrPaneClaimRow[];
  closeCandidates: HerdrPaneRow[];
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
  lifecycleManaged?: boolean;
}): HerdrPaneRow {
  const t = now();
  db.run(
    `INSERT INTO herdr_panes
       (repo_id, launch_id, pane_id, session_name, display_name, origin,
        lifecycle_managed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_id, launch_id) DO UPDATE SET
       pane_id = COALESCE(excluded.pane_id, herdr_panes.pane_id),
       session_name = COALESCE(excluded.session_name, herdr_panes.session_name),
       display_name = COALESCE(excluded.display_name, herdr_panes.display_name),
       origin = COALESCE(excluded.origin, herdr_panes.origin),
       lifecycle_managed = MAX(excluded.lifecycle_managed, herdr_panes.lifecycle_managed),
       updated_at = excluded.updated_at`,
    [
      input.repoId,
      input.launchId,
      input.paneId ?? null,
      input.sessionName ?? null,
      input.displayName ?? null,
      input.origin ?? null,
      input.lifecycleManaged ? 1 : 0,
      t,
      t,
    ],
  );
  return getHerdrPaneByLaunch(input.repoId, input.launchId) as HerdrPaneRow;
}

export function addHerdrPaneClaim(input: {
  repoId: number;
  launchId: string;
  resourceKind: string;
  resourceKey: string;
  purpose: string;
}): HerdrPaneClaimRow {
  const pane = ensureHerdrPane(input.repoId, input.launchId);
  db.run(
    `INSERT OR IGNORE INTO herdr_pane_claims
       (pane_id, resource_kind, resource_key, purpose, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [pane.id, input.resourceKind, input.resourceKey, input.purpose, now()],
  );
  return db
    .query(
      `SELECT * FROM herdr_pane_claims
       WHERE pane_id = ? AND resource_kind = ? AND resource_key = ? AND purpose = ?`,
    )
    .get(
      pane.id,
      input.resourceKind,
      input.resourceKey,
      input.purpose,
    ) as HerdrPaneClaimRow;
}

export function listHerdrPaneClaimsForResource(input: {
  repoId: number;
  resourceKind: string;
  resourceKey: string;
}): HerdrPaneClaimRow[] {
  return db
    .query(
      `SELECT c.*
       FROM herdr_pane_claims c
       JOIN herdr_panes p ON p.id = c.pane_id
       WHERE p.repo_id = ? AND c.resource_kind = ? AND c.resource_key = ?
       ORDER BY c.created_at, c.id`,
    )
    .all(
      input.repoId,
      input.resourceKind,
      input.resourceKey,
    ) as HerdrPaneClaimRow[];
}

export function releaseHerdrPaneClaimsForResource(input: {
  repoId: number;
  resourceKind: string;
  resourceKey: string;
}): HerdrPaneClaimRelease {
  db.run("BEGIN IMMEDIATE");
  try {
    const released = listHerdrPaneClaimsForResource(input).filter(
      (claim) => claim.released_at == null,
    );
    db.run(
      `UPDATE herdr_pane_claims
       SET released_at = ?
       WHERE released_at IS NULL
         AND resource_kind = ? AND resource_key = ?
         AND pane_id IN (SELECT id FROM herdr_panes WHERE repo_id = ?)`,
      [now(), input.resourceKind, input.resourceKey, input.repoId],
    );
    const closeCandidates = db
      .query(
        `SELECT DISTINCT p.*
         FROM herdr_panes p
         JOIN herdr_pane_claims target ON target.pane_id = p.id
         WHERE p.repo_id = ?
           AND target.resource_kind = ? AND target.resource_key = ?
           AND p.lifecycle_managed = 1 AND p.closed_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM herdr_pane_claims active
             WHERE active.pane_id = p.id AND active.released_at IS NULL
           )
         ORDER BY p.created_at, p.id`,
      )
      .all(
        input.repoId,
        input.resourceKind,
        input.resourceKey,
      ) as HerdrPaneRow[];
    db.run("COMMIT");
    return { released, closeCandidates };
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

export function getHerdrPaneCloseCandidate(
  paneId: number,
): HerdrPaneRow | null {
  return db
    .query(
      `SELECT p.*
       FROM herdr_panes p
       WHERE p.id = ?
         AND p.lifecycle_managed = 1 AND p.closed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM herdr_pane_claims history WHERE history.pane_id = p.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM herdr_pane_claims active
           WHERE active.pane_id = p.id AND active.released_at IS NULL
         )`,
    )
    .get(paneId) as HerdrPaneRow | null;
}

export function markHerdrPaneClosed(paneId: number): HerdrPaneRow | null {
  const t = now();
  db.run(
    `UPDATE herdr_panes SET closed_at = ?, updated_at = ?
     WHERE id = ? AND closed_at IS NULL`,
    [t, t, paneId],
  );
  return db
    .query(`SELECT * FROM herdr_panes WHERE id = ?`)
    .get(paneId) as HerdrPaneRow | null;
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
