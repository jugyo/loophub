import { db, now } from "../db.ts";
import {
  addHerdrPaneClaim,
  type HerdrPaneRow,
  linkHerdrPaneResource,
  listHerdrPanesByOrigin,
  listHerdrPanesForResource,
  registerHerdrPane,
} from "./herdr-panes.ts";
import { indexIssueSearch } from "./search.ts";

export const ISSUE_CREATE_CLAIM_PURPOSE = "issue-create-lifecycle";
export const ISSUE_FILED_FROM_RELATIONSHIP = "filed-from";

export interface IssueRow {
  id: number;
  repo_id: number;
  number: number;
  kind: "issue" | "pull";
  state: "open" | "closed";
  title: string;
  body: string;
  target_branch: string | null;
  author: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

// Compatibility alias for the existing New Issue flow. Persistence is owned by the generic
// Herdr pane registry (HerdrPaneRow); this alias keeps the issue-scoped call sites readable.
export type IssueHerdrPane = HerdrPaneRow;

export function linkIssueFiledFromHerdrPane(input: {
  repoId: number;
  launchId: string;
  issueId: number;
}): IssueHerdrPane {
  const pane = linkHerdrPaneResource({
    repoId: input.repoId,
    launchId: input.launchId,
    resourceKind: "issue",
    resourceKey: String(input.issueId),
    relationship: ISSUE_FILED_FROM_RELATIONSHIP,
  });
  addHerdrPaneClaim({
    repoId: input.repoId,
    launchId: input.launchId,
    resourceKind: "issue",
    resourceKey: String(input.issueId),
    purpose: ISSUE_CREATE_CLAIM_PURPOSE,
  });
  return pane;
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
  targetBranch?: string | null,
): IssueRow {
  const number = nextNumber(repoId);
  const t = now();
  db.run("BEGIN IMMEDIATE");
  try {
    const issue = db
      .query(
        `INSERT INTO issues (repo_id, number, kind, state, title, body, target_branch, author, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        repoId,
        number,
        kind,
        title,
        body,
        targetBranch ?? null,
        author,
        t,
        t,
      ) as IssueRow;
    indexIssueSearch(issue);
    db.run("COMMIT");
    return issue;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

export function upsertIssueHerdrPane(input: {
  launchId: string;
  repoId: number;
  issueId?: number | null;
  paneId?: string | null;
  sessionName?: string | null;
}): IssueHerdrPane {
  let pane = registerHerdrPane({
    repoId: input.repoId,
    launchId: input.launchId,
    paneId: input.paneId,
    sessionName: input.sessionName,
    displayName: "New issue",
    origin: "issue-create",
    lifecycleManaged: true,
  });
  if (input.issueId != null) {
    pane = linkIssueFiledFromHerdrPane({
      repoId: input.repoId,
      launchId: input.launchId,
      issueId: input.issueId,
    });
  }
  return pane;
}

export function getIssueHerdrPane(issueId: number): IssueHerdrPane | null {
  const issue = getIssueById(issueId);
  if (!issue) return null;
  return (
    listHerdrPanesForResource({
      repoId: issue.repo_id,
      resourceKind: "issue",
      resourceKey: String(issueId),
      relationship: ISSUE_FILED_FROM_RELATIONSHIP,
    }).find((pane) => pane.closed_at == null) ?? null
  );
}

export function listIssueHerdrPanes(repoId: number): IssueHerdrPane[] {
  return listHerdrPanesByOrigin(repoId, "issue-create");
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
  fields: {
    title?: string;
    body?: string;
    state?: "open" | "closed";
    target_branch?: string | null;
  },
) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const k of ["title", "body", "state", "target_branch"] as const) {
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
  const updatesSearch = fields.title !== undefined || fields.body !== undefined;
  if (updatesSearch) db.run("BEGIN IMMEDIATE");
  try {
    db.run(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`, params);
    if (updatesSearch) {
      const issue = getIssueById(id);
      if (issue) indexIssueSearch(issue);
      db.run("COMMIT");
    }
  } catch (error) {
    if (updatesSearch) db.run("ROLLBACK");
    throw error;
  }
}

export function getIssueById(id: number): IssueRow | null {
  return db
    .query(`SELECT * FROM issues WHERE id = ?`)
    .get(id) as IssueRow | null;
}

export function touchIssue(id: number) {
  db.run(`UPDATE issues SET updated_at = ? WHERE id = ?`, [now(), id]);
}
