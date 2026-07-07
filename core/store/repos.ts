import { db, now } from "../db.ts";
import { assertSafeRepoSegments } from "../worktree-path.ts";

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

function tableExists(name: string): boolean {
  return Boolean(
    db
      .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name),
  );
}

function deleteLegacyGroupingRows(repoId: number): void {
  const groups = ["issue", "groups"].join("_");
  const members = ["issue", "group", "members"].join("_");
  if (!tableExists(groups)) return;
  if (tableExists(members)) {
    db.run(
      `DELETE FROM ${members} WHERE group_id IN (SELECT id FROM ${groups} WHERE repo_id = ?)`,
      [repoId],
    );
  }
  db.run(`DELETE FROM ${groups} WHERE repo_id = ?`, [repoId]);
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
  // Older databases may still carry retired grouping tables with foreign keys into repos/issues.
  // Sweep their rows when present so deleting a repo remains backward-compatible.
  deleteLegacyGroupingRows(repo.id);
  db.run(`DELETE FROM issues WHERE repo_id = ?`, [repo.id]);
  db.run(`DELETE FROM labels WHERE repo_id = ?`, [repo.id]);
  db.run(`DELETE FROM events WHERE repo_id = ?`, [repo.id]);
  db.run(`DELETE FROM repos WHERE id = ?`, [repo.id]);
  return true;
}
