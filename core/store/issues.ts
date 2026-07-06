import { db, now } from "../db.ts";

export interface IssueRow {
  id: number;
  repo_id: number;
  number: number;
  kind: "issue" | "pull";
  state: "open" | "closed";
  title: string;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface IssueHerdrPane {
  launch_id: string;
  repo_id: number;
  issue_id: number | null;
  pane_id: string | null;
  session_name: string | null;
  created_at: string;
  updated_at: string;
}

// ---- issues / pulls ----
export function nextNumber(repoId: number): number {
  const row = db
    .query(
      `SELECT COALESCE(MAX(number), 0) + 1 AS n FROM issues WHERE repo_id = ?`,
    )
    .get(repoId) as { n: number };
  return row.n;
}

export function createIssue(
  repoId: number,
  kind: "issue" | "pull",
  title: string,
  body: string,
  author: string,
): IssueRow {
  const number = nextNumber(repoId);
  const t = now();
  return db
    .query(
      `INSERT INTO issues (repo_id, number, kind, state, title, body, author, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(repoId, number, kind, title, body, author, t, t) as IssueRow;
}

export function upsertIssueHerdrPane(input: {
  launchId: string;
  repoId: number;
  issueId?: number | null;
  paneId?: string | null;
  sessionName?: string | null;
}): IssueHerdrPane {
  const t = now();
  db.query(
    `INSERT INTO issue_herdr_panes
       (launch_id, repo_id, issue_id, pane_id, session_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(launch_id) DO UPDATE SET
       repo_id = excluded.repo_id,
       issue_id = COALESCE(excluded.issue_id, issue_herdr_panes.issue_id),
       pane_id = COALESCE(excluded.pane_id, issue_herdr_panes.pane_id),
       session_name = COALESCE(excluded.session_name, issue_herdr_panes.session_name),
       updated_at = excluded.updated_at
     RETURNING *`,
  ).get(
    input.launchId,
    input.repoId,
    input.issueId ?? null,
    input.paneId ?? null,
    input.sessionName ?? null,
    t,
    t,
  );
  return getIssueHerdrPaneByLaunch(input.launchId) as IssueHerdrPane;
}

export function getIssueHerdrPaneByLaunch(
  launchId: string,
): IssueHerdrPane | null {
  return (
    (db
      .query(`SELECT * FROM issue_herdr_panes WHERE launch_id = ?`)
      .get(launchId) as IssueHerdrPane) ?? null
  );
}

export function getIssueHerdrPane(issueId: number): IssueHerdrPane | null {
  return (
    (db
      .query(`SELECT * FROM issue_herdr_panes WHERE issue_id = ?`)
      .get(issueId) as IssueHerdrPane) ?? null
  );
}

export function getIssue(repoId: number, number: number): IssueRow | null {
  return db
    .query(`SELECT * FROM issues WHERE repo_id = ? AND number = ?`)
    .get(repoId, number) as IssueRow | null;
}

export function listIssues(
  repoId: number,
  kind: "issue" | "pull" | "any",
  state: string,
  sort: "updated" | "created" = "created",
): IssueRow[] {
  const conds = ["repo_id = ?"];
  const params: unknown[] = [repoId];
  if (kind !== "any") {
    conds.push("kind = ?");
    params.push(kind);
  }
  if (state !== "all") {
    conds.push("state = ?");
    params.push(state);
  }
  const orderBy =
    sort === "created"
      ? "created_at DESC, number DESC"
      : "updated_at DESC, number DESC";
  return db
    .query(
      `SELECT * FROM issues WHERE ${conds.join(" AND ")} ORDER BY ${orderBy}`,
    )
    .all(...params) as IssueRow[];
}

export function updateIssue(
  id: number,
  fields: { title?: string; body?: string; state?: "open" | "closed" },
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const k of ["title", "body", "state"] as const) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      params.push(fields[k]);
    }
  }
  // closed_at (#456): stamp once at the open->closed transition, clear on reopen. Deliberately NOT
  // touched by a title/body-only edit (fields.state undefined) or by a redundant `state: "closed"`
  // patch on an already-closed row — unlike updated_at below, which every edit bumps. This gives the
  // PR work-duration "closed" basis a stable anchor instead of one a later edit could push forward.
  if (fields.state !== undefined) {
    const current = db
      .query(`SELECT state FROM issues WHERE id = ?`)
      .get(id) as { state: string } | null;
    if (fields.state === "closed" && current?.state !== "closed") {
      sets.push("closed_at = ?");
      params.push(now());
    } else if (fields.state !== "closed" && current?.state === "closed") {
      sets.push("closed_at = NULL");
    }
  }
  sets.push("updated_at = ?");
  params.push(now());
  params.push(id);
  db.run(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`, params);
}

export function getIssueById(id: number): IssueRow | null {
  return db
    .query(`SELECT * FROM issues WHERE id = ?`)
    .get(id) as IssueRow | null;
}

export function touchIssue(id: number) {
  db.run(`UPDATE issues SET updated_at = ? WHERE id = ?`, [now(), id]);
}
