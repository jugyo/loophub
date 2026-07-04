import { db, now } from "./db.ts";
import { formatEvent, publishEvent } from "./event-hub.ts";
import type { ModelUsage } from "./session-usage.ts";
import { assertSafeRepoSegments } from "./worktree-path.ts";

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
  // #406: 'merge' | 'github_pr' | null (unset → default-by-remote, see core/merge-mode.ts).
  merge_mode: string | null;
  favorite: number;
  favorited_at: string | null;
}

// #406: the GitHub PR a loophub PR was exported to (1:1, keyed by the PR's issues row id).
export interface GithubPull {
  issue_id: number;
  number: number;
  url: string;
  branch: string | null;
  created_by: string | null;
  created_at: string;
}

// #614: the GitHub issue a loophub issue was imported from. Keyed by the loophub issue (1 import →
// 1 fresh loophub issue), but MANY loophub issues may share one GitHub source (owner/repo/number).
export interface GithubIssue {
  issue_id: number;
  owner: string;
  repo: string;
  number: number;
  url: string;
  created_by: string | null;
  created_at: string;
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
    return db
      .query(`SELECT * FROM repos ORDER BY favorite DESC, id`)
      .all() as Repo[];
  const flag = archived === "archived" ? 1 : 0;
  return db
    .query(`SELECT * FROM repos WHERE archived = ? ORDER BY favorite DESC, id`)
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

export function setRepoFavorite(id: number, favorite: boolean) {
  const favoritedAt = favorite ? now() : null;
  db.run(`UPDATE repos SET favorite = ?, favorited_at = ? WHERE id = ?`, [
    favorite ? 1 : 0,
    favoritedAt,
    id,
  ]);
}

export function isFavorite(repo: Repo): boolean {
  return !!repo.favorite;
}

// #406: set (or clear) the repo's merge-mode toggle. `mode` of null resets to the default-by-remote
// behavior; 'merge' / 'github_pr' pin the choice. The caller validates the value.
export function setRepoMergeMode(
  id: number,
  mode: "merge" | "github_pr" | null,
) {
  db.run(`UPDATE repos SET merge_mode = ? WHERE id = ?`, [mode, id]);
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
  fields: { default_branch?: string; local_path?: string; full_name?: string },
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
  if (fields.full_name !== undefined) {
    // #485: rename. Keep the derived name/owner columns in sync with full_name. Validate here
    // too (not only in repos.rename): full_name later feeds derived filesystem paths, and
    // splitName silently drops segments past the second, so a future caller skipping the
    // service-layer guard must get an error, not mangled data.
    if (fields.full_name.split("/").length > 2)
      throw new Error(`invalid repo name: "${fields.full_name}"`);
    assertSafeRepoSegments(fields.full_name, "repos.full_name");
    const [newOwner, newName] = splitName(fields.full_name);
    sets.push("full_name = ?", "name = ?", "owner = ?");
    params.push(`${newOwner}/${newName}`, newName, newOwner);
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
  // Re-fetch by id: after a full_name change the (owner, name) lookup no longer matches.
  return getRepoById(repo.id);
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
    // #406: github_pulls.issue_id has an FK to issues(id) with no cascade, so it must be swept
    // before the issues delete (foreign_keys=ON), or `lh repo remove` fails once any PR in the repo
    // has a recorded GitHub PR.
    db.run(`DELETE FROM github_pulls WHERE issue_id IN (${ph})`, issueIds);
    // #614: same FK-with-no-cascade situation as github_pulls — sweep the import links before the
    // issues delete, or `lh repo remove` fails once any issue in the repo was imported from GitHub.
    db.run(`DELETE FROM github_issues WHERE issue_id IN (${ph})`, issueIds);
    db.run(`DELETE FROM issue_herdr_panes WHERE issue_id IN (${ph})`, issueIds);
  }
  // New Issue pane links may be created before issue rows exist (issue_id NULL), so drop by repo_id
  // before the final repos delete to avoid orphaned rows blocking deletion.
  db.run(`DELETE FROM issue_herdr_panes WHERE repo_id = ?`, [repo.id]);
  // Notes are deleted by repo_id (#216): this covers both PR-linked notes and PR-independent ones
  // (issue_id NULL), so no separate issue_id sweep is needed.
  db.run(`DELETE FROM review_notes WHERE repo_id = ?`, [repo.id]);
  // Issue group membership (#312) references issues(id) and issue_groups(id); drop it before the
  // issues delete so foreign_keys=ON does not reject. Then drop the groups before the repos delete,
  // since issue_groups.repo_id references repos(id).
  db.run(
    `DELETE FROM issue_group_members WHERE group_id IN (SELECT id FROM issue_groups WHERE repo_id = ?)`,
    [repo.id],
  );
  db.run(`DELETE FROM issues WHERE repo_id = ?`, [repo.id]);
  db.run(`DELETE FROM issue_groups WHERE repo_id = ?`, [repo.id]);
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

export function getIssue(repoId: number, number: number): any {
  return db
    .query(`SELECT * FROM issues WHERE repo_id = ? AND number = ?`)
    .get(repoId, number);
}

export function listIssues(
  repoId: number,
  kind: "issue" | "pull" | "any",
  state: string,
  sort: "updated" | "created" = "updated",
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
  const orderBy =
    sort === "created"
      ? "created_at DESC, number DESC"
      : "updated_at DESC, number DESC";
  return db
    .query(
      `SELECT * FROM issues WHERE ${conds.join(" AND ")} ORDER BY ${orderBy}`,
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

export function createPull(
  issueId: number,
  head: string,
  base: string,
  headSha: string | null,
  linkedIssueId: number | null = null,
  sessionId: string | null = null,
  draft = false,
) {
  db.run(
    `INSERT INTO pulls (issue_id, head_ref, base_ref, head_sha, linked_issue_id, draft)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [issueId, head, base, headSha, linkedIssueId, draft ? 1 : 0],
  );
  // The PR's dev session is recorded only in the generalized session_links bridge (kind='dev'); the
  // PR's resume/retro anchor is derived from there (primaryDevSessionForPull). #316 dropped the
  // denormalized pulls.session_id, so this link is now the single source of truth — mirroring
  // setPullSession, which does the same when the session is (re-)attributed after creation (#298).
  if (sessionId) {
    setSessionKind(sessionId, "dev");
    linkSession(sessionId, issueId);
  }
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

// Cap on linked PRs surfaced per issue row. Normally 0–1 exist; the cap only
// bites for an issue that accumulated many (rejected attempts, multi-proposal).
// It bounds both the stacked sub-rows and — more importantly — the per-PR git
// fan-out that the issue list runs to compute each PR's status (see
// serialize.ts issueListItemJSON), keeping a single list page's git work
// bounded regardless of how many PRs an issue collects over time.
export const MAX_LINKED_PULLS = 6;

// PRs linked to an issue, most-relevant first (same ordering as
// linkedPullForIssue): open & unmerged ahead of merged/closed, then by recency.
// Capped at MAX_LINKED_PULLS so the issue list can stack them without an
// unbounded git fan-out.
export function linkedPullsForIssue(linkedIssueId: number): any[] {
  return db
    .query(
      `SELECT i.*, p.merged, p.merged_at
       FROM pulls p
       JOIN issues i ON i.id = p.issue_id
       WHERE p.linked_issue_id = ? AND i.kind = 'pull'
       ORDER BY CASE WHEN i.state = 'open' AND p.merged = 0 THEN 0 ELSE 1 END,
                COALESCE(p.merged_at, i.updated_at) DESC
       LIMIT ?`,
    )
    .all(linkedIssueId, MAX_LINKED_PULLS);
}

// Full linked-PR fan-out for issue detail. Unlike linkedPullsForIssue, this is
// intentionally uncapped: the detail page is the place where the complete issue
// history should be visible.
export function allLinkedPullsForIssue(linkedIssueId: number): any[] {
  return db
    .query(
      `SELECT i.*, p.merged, p.merged_at
       FROM pulls p
       JOIN issues i ON i.id = p.issue_id
       WHERE p.linked_issue_id = ? AND i.kind = 'pull'
       ORDER BY CASE WHEN i.state = 'open' AND p.merged = 0 THEN 0 ELSE 1 END,
                COALESCE(p.merged_at, i.updated_at) DESC`,
    )
    .all(linkedIssueId);
}

export function getPull(issueId: number): any {
  return db.query(`SELECT * FROM pulls WHERE issue_id = ?`).get(issueId);
}

export function setHeadSha(issueId: number, sha: string | null) {
  db.run(`UPDATE pulls SET head_sha = ? WHERE issue_id = ?`, [sha, issueId]);
}

// Flip a PR's draft (#413) WIP flag. `lh pr ready-for-review` clears it (draft→ready).
export function setPullDraft(issueId: number, draft: boolean) {
  db.run(`UPDATE pulls SET draft = ? WHERE issue_id = ?`, [
    draft ? 1 : 0,
    issueId,
  ]);
  touchIssue(issueId);
}

// #406: the GitHub PR a loophub PR was exported to, or null. Keyed by the PR's issues row id.
export function getGithubPull(issueId: number): GithubPull | null {
  return (
    (db
      .query(`SELECT * FROM github_pulls WHERE issue_id = ?`)
      .get(issueId) as GithubPull) ?? null
  );
}

// #406: record (or replace) the GitHub PR for a loophub PR. Idempotent on issue_id — re-recording
// overwrites, so a re-run of the export skill updates the link rather than erroring. created_at is
// preserved on overwrite (the link's first-seen time) while the rest is refreshed.
export function recordGithubPull(input: {
  issueId: number;
  number: number;
  url: string;
  branch?: string | null;
  createdBy?: string | null;
}): GithubPull {
  const { issueId, number, url, branch, createdBy } = input;
  return db
    .query(
      `INSERT INTO github_pulls (issue_id, number, url, branch, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(issue_id) DO UPDATE SET
         number = excluded.number,
         url = excluded.url,
         branch = excluded.branch,
         created_by = excluded.created_by
       RETURNING *`,
    )
    .get(
      issueId,
      number,
      url,
      branch ?? null,
      createdBy ?? null,
      now(),
    ) as GithubPull;
}

// #614: the GitHub issue a loophub issue was imported from, or null.
export function getGithubIssue(issueId: number): GithubIssue | null {
  return (
    (db
      .query(`SELECT * FROM github_issues WHERE issue_id = ?`)
      .get(issueId) as GithubIssue) ?? null
  );
}

// #614: record the GitHub source of an imported loophub issue. Unlike recordGithubPull this is a
// plain INSERT (no ON CONFLICT): each import creates a fresh loophub issue, so issue_id is always new.
export function recordGithubIssue(input: {
  issueId: number;
  owner: string;
  repo: string;
  number: number;
  url: string;
  createdBy?: string | null;
}): GithubIssue {
  const { issueId, owner, repo, number, url, createdBy } = input;
  return db
    .query(
      `INSERT INTO github_issues (issue_id, owner, repo, number, url, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      issueId,
      owner,
      repo,
      number,
      url,
      createdBy ?? null,
      now(),
    ) as GithubIssue;
}

// #614: every loophub issue imported from a given GitHub issue (many-to-one). Backs the AC that one
// GitHub issue can carry multiple loophub imports; resolved via idx_github_issues_source.
export function loophubIssuesForGithubIssue(
  owner: string,
  repo: string,
  number: number,
): GithubIssue[] {
  return db
    .query(
      `SELECT * FROM github_issues WHERE owner = ? AND repo = ? AND number = ? ORDER BY issue_id`,
    )
    .all(owner, repo, number) as GithubIssue[];
}

export function listOpenPullsForRepo(repoId: number): any[] {
  return db
    .query(
      `SELECT p.issue_id, i.number, i.title, p.head_ref, p.base_ref
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
  const t = now();
  db.run(
    `UPDATE pulls SET merged = 1, merged_at = ?, merge_commit_sha = ?, merge_method = ? WHERE issue_id = ?`,
    [t, sha, method, issueId],
  );
  // Sets closed_at alongside state (not via updateIssue, which this bypasses) so the "closed_at is
  // stamped whenever state transitions to closed" invariant holds for every close path, even though
  // pullWorkDuration never actually reads it here (a merged PR's "merged" branch — p.merged &&
  // p.merged_at — always wins first, see serialize.ts).
  db.run(
    `UPDATE issues SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`,
    [t, t, issueId],
  );
  if (pull?.linked_issue_id) {
    const linked = getIssueById(pull.linked_issue_id);
    if (linked?.state === "open") {
      db.run(
        `UPDATE issues SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`,
        [t, t, linked.id],
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
  return (
    db
      // id ASC is a deterministic tiebreaker: now() has 1-second resolution, so
      // two reviews on the same topic in the same second would otherwise have an
      // undefined order — and computeReviewGate / latestSubstantiveReview rely on
      // last-write-per-topic to gate merges (#427).
      .query(
        `SELECT * FROM reviews WHERE issue_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(issueId)
  );
}
export function createReview(
  issueId: number,
  author: string,
  event: string,
  body: string,
  headSha: string | null = null,
  topic: string | null = null,
): any {
  return db
    .query(
      `INSERT INTO reviews (issue_id, author, event, body, head_sha, topic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(issueId, author, event, body, headSha, topic, now());
}

export type ReviewState =
  | "PASSED"
  | "CHANGES_REQUESTED"
  | "READY_FOR_RE_REVIEW"
  | "COMMENTED"
  | "STALE"
  | null;

export function latestSubstantiveReview(issueId: number): any | null {
  const reviews = listReviews(issueId);
  for (let i = reviews.length - 1; i >= 0; i--) {
    const event = reviews[i].event;
    if (event === "PASS" || event === "REQUEST_CHANGES") return reviews[i];
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
  if (latest.event === "PASS") {
    // A PASS is stale once the branch head advances past the commit it was made
    // against. Passes recorded before head_sha tracking (no recorded sha) stay
    // PASSED, since their staleness can't be determined.
    if (latest.head_sha && p.head_sha && latest.head_sha !== p.head_sha)
      return "STALE";
    return "PASSED";
  }
  if (latest.event === "REQUEST_CHANGES") {
    return p.changes_addressed_at ? "READY_FOR_RE_REVIEW" : "CHANGES_REQUESTED";
  }
  return null;
}

// Per-topic merge gate (#427). The merge gate is no longer a single PASS:
// every review topic must pass independently. A topic "passes" when its latest
// substantive review (PASS / REQUEST_CHANGES) is a fresh PASS — i.e. not a
// REQUEST_CHANGES (no unresolved change request) and not a pass made stale by
// the head advancing past the reviewed commit (mirrors computeReviewState's STALE
// rule, so a passed-then-changed PR is not silently mergeable again). Topics are
// aggregated separately so a REQUEST_CHANGES on any one aspect blocks merge even
// when other aspects passed. The untagged (NULL) topic is one bucket of its own.
export interface ReviewGate {
  /** At least one topic has a substantive review (PASS / REQUEST_CHANGES). */
  reviewed: boolean;
  /** Every reviewed topic's latest substantive review passes (fresh PASS). */
  allTopicsPassed: boolean;
}

export function computeReviewGate(issueId: number): ReviewGate {
  const p = getPull(issueId);
  // ASC order (listReviews) → the last write per topic wins = latest substantive
  // review for that topic.
  const latestByTopic = new Map<string | null, any>();
  for (const r of listReviews(issueId)) {
    if (r.event === "PASS" || r.event === "REQUEST_CHANGES")
      latestByTopic.set(r.topic ?? null, r);
  }
  // No substantive review yet → reviews not gathered; never clean.
  if (latestByTopic.size === 0)
    return { reviewed: false, allTopicsPassed: false };
  for (const r of latestByTopic.values()) {
    if (r.event === "REQUEST_CHANGES")
      return { reviewed: true, allTopicsPassed: false };
    // PASS that went stale (head moved past the reviewed commit) needs a
    // re-review; passes with no recorded head_sha (pre-tracking) can't be
    // determined stale, so they count as passing.
    if (r.head_sha && p.head_sha && r.head_sha !== p.head_sha)
      return { reviewed: true, allTopicsPassed: false };
  }
  return { reviewed: true, allTopicsPassed: true };
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

export function listSessionUsage(sessionId: string): any[] {
  return db
    .query(
      `SELECT *
       FROM session_usage
       WHERE session_id = ?
       ORDER BY model`,
    )
    .all(sessionId);
}

export function listAllSessionUsage(): any[] {
  return db
    .query(
      `SELECT *
       FROM session_usage
       ORDER BY session_id, model`,
    )
    .all();
}

export function getSessionUsageCursor(sessionId: string): any | null {
  return (
    db
      .query(`SELECT * FROM session_usage_cursors WHERE session_id = ?`)
      .get(sessionId) ?? null
  );
}

export function resetSessionUsage(sessionId: string) {
  db.run(`DELETE FROM session_usage WHERE session_id = ?`, [sessionId]);
  db.run(`DELETE FROM session_usage_cursors WHERE session_id = ?`, [sessionId]);
  db.run(`DELETE FROM session_usage_messages WHERE session_id = ?`, [
    sessionId,
  ]);
}

export function insertSessionUsageMessage(
  sessionId: string,
  messageId: string,
): boolean {
  const before = db
    .query(
      `SELECT 1 AS ok FROM session_usage_messages
       WHERE session_id = ? AND message_id = ?`,
    )
    .get(sessionId, messageId);
  if (before) return false;
  db.run(
    `INSERT INTO session_usage_messages (session_id, message_id)
     VALUES (?, ?)`,
    [sessionId, messageId],
  );
  return true;
}

export function upsertSessionUsage(sessionId: string, usage: ModelUsage) {
  const t = now();
  db.run(
    `INSERT INTO session_usage
       (session_id, model, input_tokens, cache_creation_input_tokens,
        cache_read_input_tokens, output_tokens, cost_usd, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, model) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       cache_creation_input_tokens =
         cache_creation_input_tokens + excluded.cache_creation_input_tokens,
       cache_read_input_tokens =
         cache_read_input_tokens + excluded.cache_read_input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cost_usd = excluded.cost_usd,
       updated_at = excluded.updated_at`,
    [
      sessionId,
      usage.model,
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
      usage.output_tokens,
      usage.cost_usd,
      t,
    ],
  );
}

export function rewriteSessionUsageCost(
  sessionId: string,
  model: string,
  cost: number | null,
) {
  db.run(
    `UPDATE session_usage SET cost_usd = ?, updated_at = ? WHERE session_id = ? AND model = ?`,
    [cost, now(), sessionId, model],
  );
}

export function upsertSessionUsageCursor(input: {
  sessionId: string;
  transcriptPath: string;
  cursorOffset: number;
  mtimeMs: number;
}) {
  db.run(
    `INSERT INTO session_usage_cursors
       (session_id, transcript_path, cursor_offset, mtime_ms, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       transcript_path = excluded.transcript_path,
       cursor_offset = excluded.cursor_offset,
       mtime_ms = excluded.mtime_ms,
       updated_at = excluded.updated_at`,
    [
      input.sessionId,
      input.transcriptPath,
      input.cursorOffset,
      input.mtimeMs,
      now(),
    ],
  );
}

export type RegisterConflict = "CONFLICT_ID" | "CONFLICT_PAIR";

export function registerAgentSession(
  id: string,
  agent: string,
  externalSession: string,
  name?: string | null,
  runtime?: string | null,
  kind?: string | null,
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
    // Preserve-on-re-register: an undefined arg keeps the stored value (the service layer relies on
    // this — it forwards name/runtime/kind straight through without `?? null`).
    db.run(
      `UPDATE agent_sessions SET name = ?, runtime = ?, kind = ?, updated_at = ? WHERE id = ?`,
      [
        name !== undefined ? name : existing.name,
        runtime !== undefined ? runtime : existing.runtime,
        kind !== undefined ? kind : existing.kind,
        t,
        id,
      ],
    );
    return { session: getAgentSession(id), created: false };
  }
  const byPair = db
    .query(
      `SELECT id FROM agent_sessions WHERE agent = ? AND external_session = ?`,
    )
    .get(agent, externalSession) as { id: string } | null;
  if (byPair) throw new Error("CONFLICT_PAIR" satisfies RegisterConflict);
  db.query(
    `INSERT INTO agent_sessions (id, agent, external_session, name, runtime, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).get(
    id,
    agent,
    externalSession,
    name ?? null,
    runtime ?? null,
    kind ?? null,
    t,
    t,
  );
  return { session: getAgentSession(id), created: true };
}

// Set a session's kind in place (#298). Used when the kind becomes known at association time (e.g.
// `lh dev` stamps its session 'dev' when it links the PR). No-op if the session row is absent.
export function setSessionKind(sessionId: string, kind: string) {
  db.run(`UPDATE agent_sessions SET kind = ?, updated_at = ? WHERE id = ?`, [
    kind,
    now(),
    sessionId,
  ]);
}

// Link a session to an issues row (issue or PR) in the generalized session_links bridge (#298).
// Idempotent — the (session_id, issue_id) pair is the PK, so re-linking keeps the original
// created_at (INSERT OR IGNORE). The first link's created_at orders the related-sessions list.
export function linkSession(sessionId: string, issueId: number) {
  db.run(
    `INSERT OR IGNORE INTO session_links (session_id, issue_id, created_at)
     VALUES (?, ?, ?)`,
    [sessionId, issueId, now()],
  );
}

// All sessions linked to an issues row (issue or PR), newest link first. Joins the bridge to the
// session rows so callers get the full session (incl. kind/runtime) for the related-sessions list.
// `linked_at` is the bridge row's created_at (when this session was attached to this target).
export function listSessionsForIssue(issueId: number): any[] {
  return db
    .query(
      // l.rowid DESC is the tiebreaker: now() is second-resolution, so links made in the same
      // second share created_at; rowid (monotonic insert order) keeps newest-linked-first stable.
      `SELECT s.*, l.created_at AS linked_at
       FROM session_links l
       JOIN agent_sessions s ON s.id = l.session_id
       WHERE l.issue_id = ?
       ORDER BY l.created_at DESC, l.rowid DESC`,
    )
    .all(issueId);
}

export function listSessionLinkedTargets(sessionId: string): any[] {
  return db
    .query(
      `SELECT i.repo_id, i.kind, i.number
       FROM session_links l
       JOIN issues i ON i.id = l.issue_id
       WHERE l.session_id = ?
       ORDER BY i.repo_id, i.kind, i.number`,
    )
    .all(sessionId);
}

// Attribute a dev session to a PR row by recording it in the generalized session_links bridge
// (kind='dev'). `lh resume`/retro resolve the PR's implementation session from there (#186, #316).
// The PR's related-sessions list accumulates every dev session that worked it; the *primary* anchor
// is the latest-linked one (primaryDevSessionForPull) — a fresh `lh dev <pr>` re-links the session
// it is about to spawn, so latest-writer-wins still holds. As of #316 there is no denormalized
// pulls.session_id to keep in sync; the link is the single source of truth.
export function setPullSession(issueId: number, sessionId: string) {
  setSessionKind(sessionId, "dev");
  linkSession(sessionId, issueId);
}

// The PR's resume/retro anchor (#316): the latest kind='dev' session linked to the PR's issues row.
// Derived from session_links — the single source of truth since pulls.session_id was dropped. `lh
// dev` links each dev session it opens/re-enters (createPull / setPullSession), and the newest link
// wins (ORDER BY created_at DESC, rowid DESC), matching the old latest-writer-wins pulls.session_id.
// Returns the session id, or null when the PR has no dev session linked.
export function primaryDevSessionForPull(issueId: number): string | null {
  const row = db
    .query(
      `SELECT l.session_id AS id
       FROM session_links l
       JOIN agent_sessions s ON s.id = l.session_id
       WHERE l.issue_id = ? AND s.kind = 'dev'
       ORDER BY l.created_at DESC, l.rowid DESC
       LIMIT 1`,
    )
    .get(issueId) as { id: string } | null;
  return row?.id ?? null;
}

export function authorFromSession(
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;
  const s = getAgentSession(sessionId);
  if (!s) return null;
  return s.name || s.agent;
}

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

// ---- issue groups (#312) ----
// A group is a repo-scoped, ordered collection of issues, stored entirely apart from the issues
// table (see db.ts). Membership is many-to-many via issue_group_members with a per-group `position`
// for ordering; an issue may belong to several groups. All functions here are pure store access —
// validation/event emission lives in service.ts.
export function createIssueGroup(repoId: number, name: string): any {
  const t = now();
  return db
    .query(
      `INSERT INTO issue_groups (repo_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(repoId, name, t, t);
}

export function getIssueGroupById(id: number): any {
  return db.query(`SELECT * FROM issue_groups WHERE id = ?`).get(id);
}

export function getIssueGroupByName(repoId: number, name: string): any {
  return (
    db
      .query(`SELECT * FROM issue_groups WHERE repo_id = ? AND name = ?`)
      .get(repoId, name) ?? null
  );
}

export function listIssueGroups(repoId: number): any[] {
  return db
    .query(`SELECT * FROM issue_groups WHERE repo_id = ? ORDER BY name`)
    .all(repoId);
}

export function renameIssueGroup(id: number, name: string): any {
  db.run(`UPDATE issue_groups SET name = ?, updated_at = ? WHERE id = ?`, [
    name,
    now(),
    id,
  ]);
  return getIssueGroupById(id);
}

export function deleteIssueGroup(id: number): void {
  db.run(`DELETE FROM issue_group_members WHERE group_id = ?`, [id]);
  db.run(`DELETE FROM issue_groups WHERE id = ?`, [id]);
}

// Count members so a group summary can report size without listing rows.
export function countGroupMembers(groupId: number): number {
  return (
    db
      .query(`SELECT COUNT(*) AS c FROM issue_group_members WHERE group_id = ?`)
      .get(groupId) as any
  ).c;
}

// Add an issue at the end of the group's order (idempotent: re-adding an existing member is a
// no-op that keeps its current position). Returns true when a new membership was created.
export function addIssueToGroup(groupId: number, issueId: number): boolean {
  const existing = db
    .query(
      `SELECT 1 FROM issue_group_members WHERE group_id = ? AND issue_id = ?`,
    )
    .get(groupId, issueId);
  if (existing) return false;
  const next = db
    .query(
      `SELECT COALESCE(MAX(position), 0) + 1 AS p FROM issue_group_members WHERE group_id = ?`,
    )
    .get(groupId) as { p: number };
  db.run(
    `INSERT INTO issue_group_members (group_id, issue_id, position, added_at)
     VALUES (?, ?, ?, ?)`,
    [groupId, issueId, next.p, now()],
  );
  db.run(`UPDATE issue_groups SET updated_at = ? WHERE id = ?`, [
    now(),
    groupId,
  ]);
  return true;
}

// Remove an issue from a group. Returns true when a membership was actually removed. Remaining
// members keep their positions (gaps are fine — order is defined by position, not contiguity).
export function removeIssueFromGroup(
  groupId: number,
  issueId: number,
): boolean {
  const existing = db
    .query(
      `SELECT 1 FROM issue_group_members WHERE group_id = ? AND issue_id = ?`,
    )
    .get(groupId, issueId);
  if (!existing) return false;
  db.run(
    `DELETE FROM issue_group_members WHERE group_id = ? AND issue_id = ?`,
    [groupId, issueId],
  );
  db.run(`UPDATE issue_groups SET updated_at = ? WHERE id = ?`, [
    now(),
    groupId,
  ]);
  return true;
}

// Issues in a group, ordered by position (insertion order). Returns full issue rows.
export function listGroupMembers(groupId: number): any[] {
  return db
    .query(
      `SELECT i.* FROM issues i
       JOIN issue_group_members m ON m.issue_id = i.id
       WHERE m.group_id = ?
       ORDER BY m.position`,
    )
    .all(groupId);
}

// Reverse of membership: the groups an issue belongs to, ordered by name (mirrors listIssueGroups).
// Membership is many-to-many, so an issue can belong to several groups. Powers the "other issues in
// the same group" list on the issue detail view (#314).
export function listGroupsForIssue(issueId: number): any[] {
  return db
    .query(
      `SELECT g.* FROM issue_groups g
       JOIN issue_group_members m ON m.group_id = g.id
       WHERE m.issue_id = ?
       ORDER BY g.name`,
    )
    .all(issueId);
}

// ---- handoffs (#352) ----
// A handoff is one explicit document passed between a parent orchestrator and a child subagent
// (lh-build-design.ja.md §6.5). Linked to a PR (prId) and/or a generic issue (issueId), plus the
// session that recorded it (sessionId); `seq` orders handoffs per ref. Body is hybrid: inline
// `body` for content with no other home, or `src`+`hash` referencing a canonical copy (PR/commit).
// These functions are pure store access — validation, ref resolution and the body/src XOR live in
// service.ts.
export interface HandoffInput {
  repoId: number;
  prId?: number | null;
  issueId?: number | null;
  sessionId?: string | null;
  phase: string;
  direction: string;
  fromRole?: string | null;
  toRole?: string | null;
  body?: string | null;
  src?: string | null;
  hash?: string | null;
  summary?: string | null;
  model?: string | null;
  cost?: string | null;
}

// The next sequence number for a handoff's PRIMARY ref. Scope priority: the PR when present
// (handoffs accumulate on the PR), else the generic issue, else the session — the same key the row
// is filed under, and exactly what the UNIQUE partial indexes in db.ts enforce. Counting only rows
// that share that anchor keeps each ref's seq a clean 1,2,3… independent of other refs. A handoff
// binds to a single primary scope for seq purposes: binding both a PR and an issue mints seq in the
// PR scope (the issue is then a secondary link, not a second counter).
export function nextHandoffSeq(input: {
  prId?: number | null;
  issueId?: number | null;
  sessionId?: string | null;
}): number {
  let where: string;
  let param: number | string;
  if (input.prId != null) {
    where = "pr_id = ?";
    param = input.prId;
  } else if (input.issueId != null) {
    // Match the partial UNIQUE issue index predicate exactly (pr_id IS NULL AND issue_id IS NOT
    // NULL): count only issue-ONLY rows, so a dual-bound (pr+issue) row's PR-scope seq does not
    // inflate this issue's counter — keeping the per-issue seq a clean 1,2,3… as documented.
    where = "issue_id = ? AND pr_id IS NULL";
    param = input.issueId;
  } else {
    where = "session_id = ?";
    param = input.sessionId ?? "";
  }
  const row = db
    .query(`SELECT COALESCE(MAX(seq), 0) AS max FROM handoffs WHERE ${where}`)
    .get(param) as { max: number };
  return (row?.max ?? 0) + 1;
}

// Detect a UNIQUE-constraint failure from node:sqlite (errcode SQLITE_CONSTRAINT_UNIQUE = 2067,
// or the message text), distinct from SQLITE_BUSY. Used to retry a raced seq below.
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { errcode?: number; message?: string };
  return (
    e.errcode === 2067 || /UNIQUE constraint failed/i.test(e.message ?? "")
  );
}

export function createHandoff(input: HandoffInput): any {
  // seq is MAX(seq)+1 read then INSERTed in two statements, so two processes (parallel
  // `lh handoff record` from concurrent subagents) can read the same MAX and pick the same seq.
  // The UNIQUE (ref, seq) partial index (db.ts) makes the loser's INSERT throw rather than
  // duplicate; recompute seq and retry a few times so it lands on the next free number. Same
  // robustness as issues' UNIQUE (repo_id, number) backing nextNumber, made explicit here.
  for (let attempt = 0; ; attempt++) {
    const seq = nextHandoffSeq(input);
    try {
      return db
        .query(
          `INSERT INTO handoffs
            (repo_id, pr_id, issue_id, session_id, seq, phase, direction,
             from_role, to_role, body, src, hash, summary, model, cost, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          input.repoId,
          input.prId ?? null,
          input.issueId ?? null,
          input.sessionId ?? null,
          seq,
          input.phase,
          input.direction,
          input.fromRole ?? null,
          input.toRole ?? null,
          input.body ?? null,
          input.src ?? null,
          input.hash ?? null,
          input.summary ?? null,
          input.model ?? null,
          input.cost ?? null,
          now(),
        );
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 5) continue;
      throw err;
    }
  }
}

export function getHandoffById(id: number): any {
  return db.query(`SELECT * FROM handoffs WHERE id = ?`).get(id);
}

// List handoffs for a ref, in chronological order (seq asc, id breaking ties). All filters
// optional: prId narrows to one PR, issueId to a generic issue, sessionId to a session. With none,
// returns the repo's handoffs (repoId always scopes the result).
export function listHandoffs(
  repoId: number,
  opts: { prId?: number; issueId?: number; sessionId?: string } = {},
): any[] {
  const conds = ["repo_id = ?"];
  const params: any[] = [repoId];
  if (opts.prId !== undefined) {
    conds.push("pr_id = ?");
    params.push(opts.prId);
  }
  if (opts.issueId !== undefined) {
    conds.push("issue_id = ?");
    params.push(opts.issueId);
  }
  if (opts.sessionId !== undefined) {
    conds.push("session_id = ?");
    params.push(opts.sessionId);
  }
  return db
    .query(
      `SELECT * FROM handoffs WHERE ${conds.join(" AND ")}
       ORDER BY seq ASC, id ASC`,
    )
    .all(...params);
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

// The timestamp of the PR's earliest `pull_request.ready_for_review` event, or null if it never
// fired. Both transitions that emit this event type (draft→ready, and re-review after change
// requests — see service.ts `readyForReview`) carry the same `{ number, draft: false }` payload, so
// the earliest one is always the original draft→ready flip — the moment the PR first became
// reviewable. Used to anchor the "work duration" calculation (serialize.ts `pullWorkDuration`) for a
// PR that reached review but hasn't merged yet.
export function firstReadyForReviewAt(
  repoId: number,
  prNumber: number,
): string | null {
  const row = db
    .query(
      `SELECT created_at FROM events
       WHERE repo_id = ? AND type = 'pull_request.ready_for_review'
         AND json_extract(payload, '$.number') = ?
       ORDER BY id ASC LIMIT 1`,
    )
    .get(repoId, prNumber) as { created_at: string } | null;
  return row?.created_at ?? null;
}

// Events related to a single PR, newest first. Matches a repo's events whose payload targets
// the PR's own number (pull_request.*), its pr_number (handoff.recorded), or the linked issue's
// number (issue.*) — the union of every number a PR's data is filed under. Used by the debug
// view (service.pulls.debug), which has no id cursor to page through the global feed.
export function eventsForPull(
  repoId: number,
  prNumber: number,
  linkedIssueNumber: number | null,
  limit = 200,
): any[] {
  const numbers = [prNumber];
  if (linkedIssueNumber != null && linkedIssueNumber !== prNumber) {
    numbers.push(linkedIssueNumber);
  }
  const placeholders = numbers.map(() => "?").join(", ");
  return db
    .query(
      `SELECT * FROM events
       WHERE repo_id = ?
         AND (json_extract(payload, '$.number') IN (${placeholders})
              OR json_extract(payload, '$.pr_number') = ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(repoId, ...numbers, prNumber, limit);
}
