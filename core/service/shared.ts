// Helpers and paging limits shared by the service-layer modules. Service procedures are
// transport-neutral: they validate input (throwing ServiceError with an HTTP-style status),
// mutate the store, emit events, and return serialized wire objects. The CLI calls them
// directly (S5); the JSON-RPC layer (S2) wraps the same procedures. No HTTP/Request types
// leak in here. Modules import their other dependencies from the owning module, not through
// this one.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ServiceError } from "../errors.ts";
import * as S from "../store.ts";

export const MAX_EVENTS_PER_PAGE = 100;
export const DEFAULT_LIST_PER_PAGE = 30;
export const MAX_LIST_PER_PAGE = 100;

// ---- shared helpers ----
export function repoOr404(name: string): S.Repo {
  const [owner, rname] = S.splitName(name);
  const r = S.getRepo(owner, rname);
  if (!r) throw new ServiceError(404, "Not Found");
  return r;
}

export function ensureWritable(r: S.Repo): void {
  if (S.isArchived(r)) throw new ServiceError(403, "Repository is archived");
}

export function assertExistingLocalBranch(
  repoPath: string,
  branch: string,
  label = "target_branch",
): void {
  assertOptionSafeLocalBranchName(branch, label);
  if (!localBranchExists(repoPath, branch)) {
    throw new ServiceError(
      422,
      `${label} must name an existing local branch: ${branch}`,
    );
  }
}

export function ensureLocalBranchFromDefault(
  repoPath: string,
  branch: string,
  defaultBranch: string,
  label = "target_branch",
): void {
  assertCreatableLocalBranchName(branch, label);
  if (localBranchExists(repoPath, branch)) return;
  assertOptionSafeLocalBranchName(defaultBranch, "default_branch");
  if (!localBranchExists(repoPath, defaultBranch)) {
    throw new ServiceError(
      422,
      `cannot resolve default branch "${defaultBranch}"`,
    );
  }
  const result = spawnSync(
    "git",
    [
      "-C",
      repoPath,
      "branch",
      "--no-track",
      "--",
      branch,
      `refs/heads/${defaultBranch}`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new ServiceError(
      422,
      `failed to create ${label} "${branch}" from default branch "${defaultBranch}": ${result.stderr.trim() || result.stdout.trim() || "git branch failed"}`,
    );
  }
}

function assertOptionSafeLocalBranchName(branch: string, label: string): void {
  if (
    branch.startsWith("-") ||
    /[\0\r\n]/.test(branch) ||
    isRevisionSpecialBranchName(branch)
  ) {
    throw new ServiceError(422, `${label} must be a local branch name`);
  }
}

function isRevisionSpecialBranchName(branch: string): boolean {
  return (
    branch === "@" ||
    branch === "HEAD" ||
    branch.endsWith("/HEAD") ||
    /^[A-Z_]+_HEAD$/.test(branch)
  );
}

export function assertCreatableLocalBranchName(
  branch: string,
  label: string,
): void {
  assertOptionSafeLocalBranchName(branch, label);
  const result = spawnSync(
    "git",
    ["check-ref-format", `refs/heads/${branch}`],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new ServiceError(422, `${label} must be a local branch name`);
  }
}

export function localBranchExists(repoPath: string, branch: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

// Author recorded when the acting session has no `agent_sessions` row. It names no one, so callers
// that scope rows by author must treat it as unattributed rather than as a distinct actor.
export const UNKNOWN_ACTOR = "unknown";

export function actorFor(sessionId: string | null | undefined): string {
  return S.authorFromSession(sessionId) ?? UNKNOWN_ACTOR;
}

export function commentActor(sessionId: string | null | undefined): {
  actor: string;
  authorType: S.CommentAuthorType;
} {
  const session = sessionId ? S.getAgentSession(sessionId) : null;
  if (!session) return { actor: UNKNOWN_ACTOR, authorType: "system" };
  return {
    actor: session.name || session.agent,
    authorType: session.agent === "me" ? "human" : "agent",
  };
}

// Resolve symlinks so worktree paths from `git worktree list` (which canonicalizes, e.g.
// /var → /private/var on macOS) compare equal to a caller's cwd. Falls back to a plain
// absolute path when the target no longer exists.
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function issueOr404(
  r: S.Repo,
  number: number,
  kind?: "issue" | "pull",
): S.IssueRow {
  const row = S.getIssue(r.id, number);
  if (!row || (kind && row.kind !== kind))
    throw new ServiceError(404, "Not Found");
  return row;
}

export function clampPerPage(
  perPage: number | undefined,
  def: number,
  max: number,
): number {
  let v = Number(perPage ?? def);
  if (!Number.isFinite(v) || v < 1) v = def;
  return Math.min(v, max);
}

export function paginate<T>(rows: T[], perPage: number, page: number): T[] {
  const offset = (page - 1) * perPage;
  return rows.slice(offset, offset + perPage);
}
