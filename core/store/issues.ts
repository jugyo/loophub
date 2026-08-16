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
  parent_issue_id: number | null;
  sub_issue_ordinal: number | null;
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
function reserveNumber(repoId: number): number {
  // Fresh repositories do not need an eager sequence row. The caller holds one transaction across
  // this reservation and the Issue/PR insert. Rechecking surviving rows and opened-event history
  // also repairs a lagging allocator left by a rolling/partial upgrade before incrementing it.
  db.run(
    `INSERT OR IGNORE INTO repo_number_sequences (repo_id, last_number)
     VALUES (?, 0)`,
    [repoId],
  );
  return (
    db
      .query(
        `UPDATE repo_number_sequences
         SET last_number = max(
           last_number,
           COALESCE((SELECT MAX(number) FROM issues WHERE repo_id = ?), 0),
           COALESCE((
             SELECT MAX(
               CASE WHEN json_valid(payload)
                 THEN CAST(json_extract(payload, '$.number') AS INTEGER)
                 ELSE 0
               END
             )
             FROM events
             WHERE repo_id = ? AND type IN ('issue.opened', 'pull_request.opened')
           ), 0)
         ) + 1
         WHERE repo_id = ?
         RETURNING last_number`,
      )
      .get(repoId, repoId, repoId) as { last_number: number }
  ).last_number;
}

export function reserveIssueNumber(repoId: number): number {
  return db.transaction(() => reserveNumber(repoId));
}

function insertIssue(
  repoId: number,
  number: number,
  kind: "issue" | "pull",
  title: string,
  body: string,
  author: string,
  targetBranch?: string | null,
): IssueRow {
  const t = now();
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
  return issue;
}

export function createIssueWithNumber(
  repoId: number,
  number: number,
  kind: "issue" | "pull",
  title: string,
  body: string,
  author: string,
  targetBranch?: string | null,
): IssueRow {
  return db.transaction(() =>
    insertIssue(repoId, number, kind, title, body, author, targetBranch),
  );
}

export function createIssue(
  repoId: number,
  kind: "issue" | "pull",
  title: string,
  body: string,
  author: string,
  targetBranch?: string | null,
): IssueRow {
  return db.transaction(() => {
    const number = reserveNumber(repoId);
    return insertIssue(repoId, number, kind, title, body, author, targetBranch);
  });
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

export function issueHerdrPanesByIssue(
  repoId: number,
  issueIds: number[],
): Map<number, IssueHerdrPane> {
  if (issueIds.length === 0) return new Map();
  const placeholders = issueIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT p.*, CAST(r.resource_key AS INTEGER) AS issue_id
       FROM herdr_panes p
       JOIN herdr_pane_resources r ON r.pane_id = p.id
       WHERE p.repo_id = ?
         AND r.resource_kind = 'issue'
         AND r.relationship = ?
         AND p.closed_at IS NULL
         AND CAST(r.resource_key AS INTEGER) IN (${placeholders})
       ORDER BY p.created_at, p.id`,
    )
    .all(
      repoId,
      ISSUE_FILED_FROM_RELATIONSHIP,
      ...issueIds,
    ) as (IssueHerdrPane & {
    issue_id: number;
  })[];
  const byIssue = new Map<number, IssueHerdrPane>();
  for (const row of rows) {
    if (!byIssue.has(row.issue_id)) byIssue.set(row.issue_id, row);
  }
  return byIssue;
}

export function getIssue(repoId: number, number: number): IssueRow | null {
  return db
    .query(`SELECT * FROM issues WHERE repo_id = ? AND number = ?`)
    .get(repoId, number) as IssueRow | null;
}

export interface IssueKindRow {
  number: number;
  kind: "issue" | "pull";
}

/**
 * Kind of each of `numbers` within the repo. Numbers with no row are omitted, so the
 * caller can tell "this number is an issue" from "this number does not exist".
 */
export function listIssueKinds(
  repoId: number,
  numbers: number[],
): IssueKindRow[] {
  if (numbers.length === 0) return [];
  const placeholders = numbers.map(() => "?").join(", ");
  return db
    .query(
      `SELECT number, kind FROM issues
       WHERE repo_id = ? AND number IN (${placeholders})
       ORDER BY number`,
    )
    .all(repoId, ...numbers) as IssueKindRow[];
}

export function listIssues(
  repoId: number,
  kind: "issue" | "pull" | "any",
  state: string,
  sort: "updated" | "created" = "created",
  opts: { rootsOnly?: boolean } = {},
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
  if (opts.rootsOnly) conds.push("parent_issue_id IS NULL");
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

export function listSubIssues(parentId: number): IssueRow[] {
  return db
    .query(
      `SELECT * FROM issues
       WHERE parent_issue_id = ?
       ORDER BY sub_issue_ordinal, id`,
    )
    .all(parentId) as IssueRow[];
}

export interface SubIssueSummary {
  total: number;
  open: number;
  closed: number;
}

export function subIssueSummariesByParent(
  parentIds: number[],
): Map<number, SubIssueSummary> {
  if (parentIds.length === 0) return new Map();
  const placeholders = parentIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT parent_issue_id,
              COUNT(*) AS total,
              SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN state = 'closed' THEN 1 ELSE 0 END) AS closed
       FROM issues
       WHERE parent_issue_id IN (${placeholders})
       GROUP BY parent_issue_id`,
    )
    .all(...parentIds) as (SubIssueSummary & { parent_issue_id: number })[];
  return new Map(
    rows.map(({ parent_issue_id, total, open, closed }) => [
      parent_issue_id,
      { total, open, closed },
    ]),
  );
}

function requireTraversalLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(
      `issue hierarchy limit must be a positive integer: ${limit}`,
    );
  }
}

export function listAncestorRows(issueId: number, limit: number): IssueRow[] {
  requireTraversalLimit(limit);
  const rows = db
    .query(
      `WITH RECURSIVE ancestors AS (
         SELECT parent_issue_id AS id, 1 AS depth
         FROM issues WHERE id = ? AND parent_issue_id IS NOT NULL
         UNION ALL
         SELECT issues.parent_issue_id, ancestors.depth + 1
         FROM issues JOIN ancestors ON issues.id = ancestors.id
         WHERE issues.parent_issue_id IS NOT NULL AND ancestors.depth < ?
       )
       SELECT issues.* FROM issues
       JOIN ancestors ON ancestors.id = issues.id
       ORDER BY ancestors.depth`,
    )
    .all(issueId, limit) as IssueRow[];
  if (rows.length === limit && rows.at(-1)?.parent_issue_id != null) {
    throw new Error(`issue ancestor traversal exceeded limit: ${limit}`);
  }
  return rows;
}

export function listDescendantIds(issueId: number, limit: number): number[] {
  requireTraversalLimit(limit);
  const rows = db
    .query(
      `WITH RECURSIVE descendants AS (
         SELECT id, 1 AS depth FROM issues WHERE parent_issue_id = ?
         UNION ALL
         SELECT issues.id, descendants.depth + 1
         FROM issues JOIN descendants ON issues.parent_issue_id = descendants.id
         WHERE descendants.depth <= ?
       )
       SELECT id, depth FROM descendants`,
    )
    .all(issueId, limit) as { id: number; depth: number }[];
  if (rows.some((row) => row.depth > limit)) {
    throw new Error(`issue descendant traversal exceeded limit: ${limit}`);
  }
  return rows.filter((row) => row.depth <= limit).map((row) => row.id);
}

export function subtreeHeight(issueId: number, limit: number): number {
  requireTraversalLimit(limit);
  const rows = db
    .query(
      `WITH RECURSIVE subtree AS (
         SELECT id, 1 AS depth FROM issues WHERE id = ?
         UNION ALL
         SELECT issues.id, subtree.depth + 1
         FROM issues JOIN subtree ON issues.parent_issue_id = subtree.id
         WHERE subtree.depth <= ?
       )
       SELECT depth FROM subtree`,
    )
    .all(issueId, limit) as { depth: number }[];
  if (rows.some((row) => row.depth > limit)) {
    throw new Error(`issue subtree traversal exceeded limit: ${limit}`);
  }
  return Math.max(...rows.map((row) => row.depth), 0);
}

export function nextSubIssueOrdinal(parentId: number): number {
  return (
    db
      .query(
        `SELECT COALESCE(MAX(sub_issue_ordinal), 0) + 1 AS ordinal
         FROM issues WHERE parent_issue_id = ?`,
      )
      .get(parentId) as { ordinal: number }
  ).ordinal;
}

export function setIssueParent(
  childId: number,
  parentId: number | null,
  ordinal: number | null,
): void {
  db.run(
    `UPDATE issues
     SET parent_issue_id = ?, sub_issue_ordinal = ?, updated_at = ?
     WHERE id = ?`,
    [parentId, ordinal, now(), childId],
  );
}

export function reorderSubIssues(
  parentId: number,
  orderedChildIds: number[],
): void {
  db.transaction(() => {
    orderedChildIds.forEach((id, index) => {
      db.run(
        `UPDATE issues SET sub_issue_ordinal = ?, updated_at = ?
         WHERE id = ? AND parent_issue_id = ?`,
        [index + 1, now(), id, parentId],
      );
    });
  });
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
  const apply = () => {
    db.run(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`, params);
    if (updatesSearch) {
      const issue = getIssueById(id);
      if (issue) indexIssueSearch(issue);
    }
  };
  // A title/body edit also rewrites the search index, so the row and its index move together.
  if (updatesSearch) db.transaction(apply);
  else apply();
}

export function getIssueById(id: number): IssueRow | null {
  return db
    .query(`SELECT * FROM issues WHERE id = ?`)
    .get(id) as IssueRow | null;
}

export function touchIssue(id: number) {
  db.run(`UPDATE issues SET updated_at = ? WHERE id = ?`, [now(), id]);
}
