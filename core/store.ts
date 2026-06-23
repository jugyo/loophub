import { db, now } from "./db.ts";
import { formatEvent, publishEvent } from "./event-hub.ts";

export interface Repo {
  id: number;
  full_name: string;
  name: string;
  owner: string;
  local_path: string;
  default_branch: string;
  created_at: string;
  archived: number;
  archived_at: string | null;
}

// ---- repos ----
export function splitName(fullName: string): [string, string] {
  return (fullName.includes("/") ? fullName.split("/") : ["me", fullName]) as [
    string,
    string,
  ];
}

export function createRepo(
  fullName: string,
  localPath: string,
  defaultBranch = "main",
): Repo {
  const [owner, name] = splitName(fullName);
  const full = `${owner}/${name}`; // slash 無し入力も me/<name> に正規化
  return db
    .query(
      `INSERT INTO repos (full_name, name, owner, local_path, default_branch, created_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(full, name, owner, localPath, defaultBranch, now()) as Repo;
}

export function listRepos(
  archived: "active" | "archived" | "all" = "active",
): Repo[] {
  if (archived === "all")
    return db.query(`SELECT * FROM repos ORDER BY id`).all() as Repo[];
  const flag = archived === "archived" ? 1 : 0;
  return db
    .query(`SELECT * FROM repos WHERE archived = ? ORDER BY id`)
    .all(flag) as Repo[];
}

export function setRepoArchived(id: number, archived: boolean) {
  const archivedAt = archived ? now() : null;
  db.run(`UPDATE repos SET archived = ?, archived_at = ? WHERE id = ?`, [
    archived ? 1 : 0,
    archivedAt,
    id,
  ]);
}

export function isArchived(repo: Repo): boolean {
  return !!repo.archived;
}

export function getRepoById(id: number): Repo | null {
  return db.query(`SELECT * FROM repos WHERE id = ?`).get(id) as Repo | null;
}

export function getRepo(owner: string, name: string): Repo | null {
  return (
    (db
      .query(`SELECT * FROM repos WHERE full_name = ?`)
      .get(`${owner}/${name}`) as Repo) ?? null
  );
}

export function updateRepo(
  owner: string,
  name: string,
  fields: { default_branch?: string; local_path?: string },
  headShas?: { issueId: number; sha: string | null }[],
): Repo | null {
  const repo = getRepo(owner, name);
  if (!repo) return null;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.default_branch !== undefined) {
    sets.push("default_branch = ?");
    params.push(fields.default_branch);
  }
  if (fields.local_path !== undefined) {
    sets.push("local_path = ?");
    params.push(fields.local_path);
  }
  if (!sets.length && !headShas?.length) return repo;

  const apply = () => {
    if (sets.length) {
      const updateParams = [...params, repo.id];
      db.run(`UPDATE repos SET ${sets.join(", ")} WHERE id = ?`, updateParams);
    }
    for (const h of headShas ?? []) {
      db.run(`UPDATE pulls SET head_sha = ? WHERE issue_id = ?`, [
        h.sha,
        h.issueId,
      ]);
    }
  };

  if (headShas?.length) {
    db.run("BEGIN IMMEDIATE");
    try {
      apply();
      db.run("COMMIT");
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  } else {
    apply();
  }
  return getRepo(owner, name);
}

export function deleteRepo(owner: string, name: string): boolean {
  const repo = getRepo(owner, name);
  if (!repo) return false;
  const issues = db
    .query(`SELECT id FROM issues WHERE repo_id = ?`)
    .all(repo.id) as { id: number }[];
  const issueIds = issues.map((i) => i.id);
  if (issueIds.length) {
    const ph = issueIds.map(() => "?").join(",");
    db.run(`DELETE FROM review_comments WHERE issue_id IN (${ph})`, issueIds);
    db.run(`DELETE FROM reviews WHERE issue_id IN (${ph})`, issueIds);
    db.run(`DELETE FROM comments WHERE issue_id IN (${ph})`, issueIds);
    db.run(`DELETE FROM pulls WHERE issue_id IN (${ph})`, issueIds);
    db.run(`DELETE FROM issue_labels WHERE issue_id IN (${ph})`, issueIds);
  }
  db.run(`DELETE FROM issues WHERE repo_id = ?`, [repo.id]);
  db.run(`DELETE FROM labels WHERE repo_id = ?`, [repo.id]);
  db.run(`DELETE FROM events WHERE repo_id = ?`, [repo.id]);
  db.run(`DELETE FROM repos WHERE id = ?`, [repo.id]);
  return true;
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
): any {
  const number = nextNumber(repoId);
  const t = now();
  return db
    .query(
      `INSERT INTO issues (repo_id, number, kind, state, title, body, author, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(repoId, number, kind, title, body, author, t, t);
}

export function getIssue(repoId: number, number: number): any {
  return db
    .query(`SELECT * FROM issues WHERE repo_id = ? AND number = ?`)
    .get(repoId, number);
}

export function listIssues(
  repoId: number,
  kind: "issue" | "pull" | "any",
  state: string,
): any[] {
  const conds = ["repo_id = ?"];
  const params: any[] = [repoId];
  if (kind !== "any") {
    conds.push("kind = ?");
    params.push(kind);
  }
  if (state !== "all") {
    conds.push("state = ?");
    params.push(state);
  }
  return db
    .query(
      `SELECT * FROM issues WHERE ${conds.join(" AND ")} ORDER BY updated_at DESC, number DESC`,
    )
    .all(...params);
}

export function listPulls(
  repoId: number,
  state: string,
  merged?: "only" | "exclude" | null,
): any[] {
  const conds = ["i.repo_id = ?", "i.kind = 'pull'"];
  const params: any[] = [repoId];
  if (state !== "all") {
    conds.push("i.state = ?");
    params.push(state);
  }
  if (merged === "only") {
    conds.push("p.merged = 1");
  } else if (merged === "exclude") {
    conds.push("p.merged = 0");
  }
  const order =
    merged === "only"
      ? "COALESCE(p.merged_at, i.updated_at) DESC, i.number DESC"
      : "i.number DESC";
  return db
    .query(
      `SELECT i.* FROM issues i
       INNER JOIN pulls p ON p.issue_id = i.id
       WHERE ${conds.join(" AND ")}
       ORDER BY ${order}`,
    )
    .all(...params);
}

export function updateIssue(id: number, fields: Record<string, any>) {
  const sets: string[] = [];
  const params: any[] = [];
  for (const k of ["title", "body", "state"]) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      params.push(fields[k]);
    }
  }
  sets.push("updated_at = ?");
  params.push(now());
  params.push(id);
  db.run(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`, params);
}

export function createPull(
  issueId: number,
  head: string,
  base: string,
  headSha: string | null,
  linkedIssueId: number | null = null,
) {
  db.run(
    `INSERT INTO pulls (issue_id, head_ref, base_ref, head_sha, linked_issue_id) VALUES (?, ?, ?, ?, ?)`,
    [issueId, head, base, headSha, linkedIssueId],
  );
}

export function getIssueById(id: number): any {
  return db.query(`SELECT * FROM issues WHERE id = ?`).get(id);
}

export function openPullLinkedToIssue(linkedIssueId: number): any | null {
  return (
    db
      .query(
        `SELECT i.*, p.merged
         FROM pulls p
         JOIN issues i ON i.id = p.issue_id
         WHERE p.linked_issue_id = ? AND i.kind = 'pull' AND i.state = 'open' AND p.merged = 0
         LIMIT 1`,
      )
      .get(linkedIssueId) ?? null
  );
}

export function linkedPullForIssue(linkedIssueId: number): any | null {
  return (
    db
      .query(
        `SELECT i.*, p.merged, p.merged_at
         FROM pulls p
         JOIN issues i ON i.id = p.issue_id
         WHERE p.linked_issue_id = ? AND i.kind = 'pull'
         ORDER BY CASE WHEN i.state = 'open' AND p.merged = 0 THEN 0 ELSE 1 END,
                  COALESCE(p.merged_at, i.updated_at) DESC
         LIMIT 1`,
      )
      .get(linkedIssueId) ?? null
  );
}

export function getPull(issueId: number): any {
  return db.query(`SELECT * FROM pulls WHERE issue_id = ?`).get(issueId);
}

export function setHeadSha(issueId: number, sha: string | null) {
  db.run(`UPDATE pulls SET head_sha = ? WHERE issue_id = ?`, [sha, issueId]);
}

export function listOpenPullsForRepo(repoId: number): any[] {
  return db
    .query(
      `SELECT p.issue_id, p.head_ref
       FROM pulls p
       JOIN issues i ON i.id = p.issue_id
       WHERE i.repo_id = ? AND i.kind = 'pull' AND i.state = 'open' AND p.merged = 0`,
    )
    .all(repoId);
}

export function touchIssue(id: number) {
  db.run(`UPDATE issues SET updated_at = ? WHERE id = ?`, [now(), id]);
}

// open な PR を repo パス付きで返す（ref スイープ用）
export function openPulls(): any[] {
  return db
    .query(
      `SELECT i.id AS issue_id, i.repo_id, i.number, i.author,
              p.head_ref, p.head_sha, r.local_path
       FROM issues i
       JOIN pulls p ON p.issue_id = i.id
       JOIN repos r ON r.id = i.repo_id
       WHERE i.kind = 'pull' AND i.state = 'open' AND p.merged = 0 AND r.archived = 0`,
    )
    .all();
}

export function setMerged(
  issueId: number,
  sha: string,
  method: string,
): number | null {
  const pull = getPull(issueId);
  db.run(
    `UPDATE pulls SET merged = 1, merged_at = ?, merge_commit_sha = ?, merge_method = ? WHERE issue_id = ?`,
    [now(), sha, method, issueId],
  );
  db.run(`UPDATE issues SET state = 'closed', updated_at = ? WHERE id = ?`, [
    now(),
    issueId,
  ]);
  if (pull?.linked_issue_id) {
    const linked = getIssueById(pull.linked_issue_id);
    if (linked?.state === "open") {
      db.run(
        `UPDATE issues SET state = 'closed', updated_at = ? WHERE id = ?`,
        [now(), linked.id],
      );
      return linked.number;
    }
  }
  return null;
}

// ---- comments ----
export function listComments(issueId: number): any[] {
  return db
    .query(`SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC`)
    .all(issueId);
}
export function createComment(
  issueId: number,
  author: string,
  body: string,
): any {
  const t = now();
  return db
    .query(
      `INSERT INTO comments (issue_id, author, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(issueId, author, body, t, t);
}
export function countComments(issueId: number): number {
  return (
    db
      .query(`SELECT COUNT(*) AS c FROM comments WHERE issue_id = ?`)
      .get(issueId) as any
  ).c;
}

// ---- reviews ----
export function listReviews(issueId: number): any[] {
  return db
    .query(`SELECT * FROM reviews WHERE issue_id = ? ORDER BY created_at ASC`)
    .all(issueId);
}
export function createReview(
  issueId: number,
  author: string,
  event: string,
  body: string,
): any {
  return db
    .query(
      `INSERT INTO reviews (issue_id, author, event, body, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(issueId, author, event, body, now());
}

export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "READY_FOR_RE_REVIEW"
  | "COMMENTED"
  | null;

export function latestSubstantiveReview(issueId: number): any | null {
  const reviews = listReviews(issueId);
  for (let i = reviews.length - 1; i >= 0; i--) {
    const event = reviews[i].event;
    if (event === "APPROVE" || event === "REQUEST_CHANGES") return reviews[i];
  }
  return null;
}

export function computeReviewState(issueId: number): ReviewState {
  const p = getPull(issueId);
  const latest = latestSubstantiveReview(issueId);
  if (!latest) {
    return listReviews(issueId).some((r) => r.event === "COMMENT")
      ? "COMMENTED"
      : null;
  }
  if (latest.event === "APPROVE") return "APPROVED";
  if (latest.event === "REQUEST_CHANGES") {
    return p.changes_addressed_at ? "READY_FOR_RE_REVIEW" : "CHANGES_REQUESTED";
  }
  return null;
}

export function markChangesAddressed(issueId: number, actor: string) {
  db.run(
    `UPDATE pulls SET changes_addressed_at = ?, changes_addressed_by = ? WHERE issue_id = ?`,
    [now(), actor, issueId],
  );
  touchIssue(issueId);
}

export function clearChangesAddressed(issueId: number) {
  db.run(
    `UPDATE pulls SET changes_addressed_at = NULL, changes_addressed_by = NULL WHERE issue_id = ?`,
    [issueId],
  );
}

// ---- review comments (行コメント。投稿は review に束ねる) ----
export function createReviewComment(
  issueId: number,
  reviewId: number,
  author: string,
  c: { path: string; line?: number; side?: string; body: string },
): any {
  return db
    .query(
      `INSERT INTO review_comments (issue_id, review_id, author, body, path, line, side, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      issueId,
      reviewId,
      author,
      c.body,
      c.path,
      c.line ?? null,
      c.side ?? "RIGHT",
      now(),
    );
}

export function listReviewComments(issueId: number): any[] {
  return db
    .query(
      `SELECT * FROM review_comments WHERE issue_id = ? ORDER BY created_at ASC`,
    )
    .all(issueId);
}

// ---- labels ----
export function ensureLabel(repoId: number, name: string): any {
  let l = db
    .query(`SELECT * FROM labels WHERE repo_id = ? AND name = ?`)
    .get(repoId, name);
  if (!l)
    l = db
      .query(`INSERT INTO labels (repo_id, name) VALUES (?, ?) RETURNING *`)
      .get(repoId, name);
  return l;
}
export function listLabels(repoId: number): any[] {
  return db
    .query(`SELECT * FROM labels WHERE repo_id = ? ORDER BY name`)
    .all(repoId);
}
export function issueLabels(issueId: number): any[] {
  return db
    .query(
      `SELECT l.* FROM labels l JOIN issue_labels il ON il.label_id = l.id
       WHERE il.issue_id = ? ORDER BY l.name`,
    )
    .all(issueId);
}
export function addLabels(repoId: number, issueId: number, names: string[]) {
  for (const n of names) {
    const l = ensureLabel(repoId, n) as any;
    db.run(
      `INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)`,
      [issueId, l.id],
    );
  }
}
export function setLabels(repoId: number, issueId: number, names: string[]) {
  db.run(`DELETE FROM issue_labels WHERE issue_id = ?`, [issueId]);
  addLabels(repoId, issueId, names);
}
export function removeLabel(repoId: number, issueId: number, name: string) {
  const l = db
    .query(`SELECT id FROM labels WHERE repo_id = ? AND name = ?`)
    .get(repoId, name) as any;
  if (l)
    db.run(`DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?`, [
      issueId,
      l.id,
    ]);
}

// ---- events ----
// ---- agent sessions ----
export function getAgentSession(id: string): any | null {
  return db.query(`SELECT * FROM agent_sessions WHERE id = ?`).get(id) ?? null;
}

export function listAgentSessions(): any[] {
  return db
    .query(`SELECT * FROM agent_sessions ORDER BY updated_at DESC`)
    .all();
}

export type RegisterConflict = "CONFLICT_ID" | "CONFLICT_PAIR";

export function registerAgentSession(
  id: string,
  agent: string,
  externalSession: string,
  name?: string | null,
): { session: any; created: boolean } {
  const existing = getAgentSession(id);
  const t = now();
  if (existing) {
    if (
      existing.agent !== agent ||
      existing.external_session !== externalSession
    ) {
      throw new Error("CONFLICT_ID" satisfies RegisterConflict);
    }
    db.run(`UPDATE agent_sessions SET name = ?, updated_at = ? WHERE id = ?`, [
      name !== undefined ? name : existing.name,
      t,
      id,
    ]);
    return { session: getAgentSession(id), created: false };
  }
  const byPair = db
    .query(
      `SELECT id FROM agent_sessions WHERE agent = ? AND external_session = ?`,
    )
    .get(agent, externalSession) as { id: string } | null;
  if (byPair) throw new Error("CONFLICT_PAIR" satisfies RegisterConflict);
  db.query(
    `INSERT INTO agent_sessions (id, agent, external_session, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(id, agent, externalSession, name ?? null, t, t);
  return { session: getAgentSession(id), created: true };
}

export type AssignConflict =
  | "NOT_FOUND"
  | "CONFLICT_ASSIGNED"
  | "CONFLICT_SESSION";

export function assignIssueToSession(issueId: number, sessionId: string) {
  const session = getAgentSession(sessionId);
  if (!session) throw new Error("NOT_FOUND" satisfies AssignConflict);
  const issue = db
    .query(`SELECT * FROM issues WHERE id = ?`)
    .get(issueId) as any;
  if (issue.assignee_session_id && issue.assignee_session_id !== sessionId) {
    throw new Error("CONFLICT_ASSIGNED" satisfies AssignConflict);
  }
  const other = db
    .query(`SELECT id FROM issues WHERE assignee_session_id = ? AND id != ?`)
    .get(sessionId, issueId) as { id: number } | null;
  if (other) throw new Error("CONFLICT_SESSION" satisfies AssignConflict);
  db.run(
    `UPDATE issues SET assignee_session_id = ?, updated_at = ? WHERE id = ?`,
    [sessionId, now(), issueId],
  );
}

export function unassignIssue(issueId: number, sessionId?: string | null) {
  const issue = db
    .query(`SELECT * FROM issues WHERE id = ?`)
    .get(issueId) as any;
  if (!issue.assignee_session_id) return null;
  if (sessionId && issue.assignee_session_id !== sessionId) {
    throw new Error("CONFLICT_ASSIGNED" satisfies AssignConflict);
  }
  const prev = issue.assignee_session_id;
  db.run(
    `UPDATE issues SET assignee_session_id = NULL, updated_at = ? WHERE id = ?`,
    [now(), issueId],
  );
  return prev as string;
}

export function assigneeJSON(sessionId: string | null | undefined): any | null {
  if (!sessionId) return null;
  const s = getAgentSession(sessionId);
  if (!s) return null;
  const out: any = {
    session_id: s.id,
    agent: s.agent,
    session: s.external_session,
  };
  if (s.name) out.name = s.name;
  return out;
}

export function authorFromSession(
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;
  const s = getAgentSession(sessionId);
  if (!s) return null;
  return s.name || s.agent;
}

// ---- events ----
// Persist then publish LoopEvent to in-process hub (order matters for SSE replay consistency).
export function emitEvent(
  repoId: number | null,
  type: string,
  actor: string,
  payload: any,
): any {
  const row = db
    .query(
      `INSERT INTO events (repo_id, type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(repoId, type, actor, JSON.stringify(payload), now());
  const repo = repoId !== null ? getRepoById(repoId) : null;
  publishEvent(formatEvent(row as any, repo?.full_name));
  return row;
}
// labels: when set, keep only events whose issue/PR (payload.number, same repo) currently
// carries one of the given label names (OR match). Events without a payload.number are dropped.
// order: "asc" (default) returns the oldest matching events after `since` (used for
// polling/SSE replay forward by id). "desc" returns the newest matching events first
// (the tail), used by dashboard activity feeds that want the most recent N events.
export function listEvents(
  since: number,
  repoId: number | null,
  limit: number,
  labels?: string[],
  order: "asc" | "desc" = "asc",
): any[] {
  const clauses = ["id > ?"];
  const params: any[] = [since];
  if (repoId !== null) {
    clauses.push("repo_id = ?");
    params.push(repoId);
  }
  if (labels && labels.length > 0) {
    const placeholders = labels.map(() => "?").join(", ");
    clauses.push(`EXISTS (
      SELECT 1 FROM issues i
      JOIN issue_labels il ON il.issue_id = i.id
      JOIN labels l ON l.id = il.label_id
      WHERE i.repo_id = events.repo_id
        AND i.number = json_extract(events.payload, '$.number')
        AND l.name IN (${placeholders})
    )`);
    params.push(...labels);
  }
  params.push(limit);
  const dir = order === "desc" ? "DESC" : "ASC";
  return db
    .query(
      `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY id ${dir} LIMIT ?`,
    )
    .all(...params);
}
