import { ServiceError } from "../errors.ts";
import { git } from "../git.ts";
import {
  repoJSON,
  type WorkspaceResolutionWire,
  workspaceJSON,
} from "../serialize.ts";
import * as S from "../store.ts";
import {
  actorFor,
  assertCreatableLocalBranchName,
  ensureLocalBranchFromDefault,
  ensureWritable,
  localBranchExists,
  repoOr404,
} from "./shared.ts";

function workspaceOr404(repoId: number, branch: string): S.Workspace {
  const workspace = S.getWorkspace(repoId, branch);
  if (!workspace) throw new ServiceError(404, "Not Found");
  return workspace;
}

async function hasUnmergedCommits(
  repoPath: string,
  defaultBranch: string,
  workspaceBranch: string,
): Promise<boolean> {
  const result = await git(repoPath, [
    "rev-list",
    "--count",
    `refs/heads/${defaultBranch}..refs/heads/${workspaceBranch}`,
  ]);
  if (result.code !== 0) {
    throw new ServiceError(
      500,
      `failed to compare workspace branch "${workspaceBranch}" with default branch "${defaultBranch}": ${result.stderr.trim() || result.stdout.trim() || "git rev-list failed"}`,
    );
  }
  return Number(result.stdout.trim()) > 0;
}

function setArchived(
  repo: string,
  branch: string,
  archived: boolean,
  sessionId?: string | null,
) {
  const r = repoOr404(repo);
  workspaceOr404(r.id, branch);
  S.setWorkspaceArchived(r.id, branch, archived);
  const workspace = workspaceOr404(r.id, branch);
  S.emitEvent(
    r.id,
    archived ? "workspace.archived" : "workspace.unarchived",
    actorFor(sessionId),
    { branch },
  );
  return workspaceJSON(workspace, localBranchExists(r.local_path, branch));
}

function listWorkspaceRows(
  repo: string,
  archived: boolean,
  excludeDefaultBranch: boolean,
) {
  const r = repoOr404(repo);
  const workspaces = archived
    ? S.listArchivedWorkspaces(r.id)
    : S.listWorkspaces(r.id);
  return workspaces
    .filter(
      (workspace) =>
        !excludeDefaultBranch || workspace.branch !== r.default_branch,
    )
    .map((workspace) =>
      workspaceJSON(
        workspace,
        localBranchExists(r.local_path, workspace.branch),
      ),
    );
}

export const workspaces = {
  resolve(branch: string): WorkspaceResolutionWire {
    const matches = S.findActiveWorkspacesByBranch(branch);
    if (matches.length === 0) {
      throw new ServiceError(404, `workspace not found: ${branch}`);
    }
    if (matches.length > 1) {
      throw new ServiceError(409, `workspace name is ambiguous: ${branch}`);
    }
    const workspace = matches[0];
    const repo = S.getRepoById(workspace.repo_id);
    if (!repo) throw new ServiceError(404, "Not Found");
    return {
      repo: repoJSON(repo),
      workspace: workspaceJSON(
        workspace,
        localBranchExists(repo.local_path, branch),
      ),
    };
  },

  create(repo: string, input: { branch: string }, sessionId?: string | null) {
    const r = repoOr404(repo);
    ensureWritable(r);
    const branch = input?.branch;
    if (typeof branch !== "string" || !branch) {
      throw new ServiceError(422, "workspace branch is required");
    }
    assertCreatableLocalBranchName(branch, "workspace branch");
    if (branch === r.default_branch) {
      throw new ServiceError(
        422,
        "workspace branch must differ from the default branch",
      );
    }
    if (S.getWorkspace(r.id, branch)) {
      throw new ServiceError(422, `workspace already registered: ${branch}`);
    }
    if (localBranchExists(r.local_path, branch)) {
      throw new ServiceError(422, `workspace branch already exists: ${branch}`);
    }

    ensureLocalBranchFromDefault(
      r.local_path,
      branch,
      r.default_branch,
      "workspace branch",
    );
    const workspace = S.createWorkspace(r.id, branch);
    S.emitEvent(r.id, "workspace.created", actorFor(sessionId), { branch });
    return workspaceJSON(workspace, true);
  },

  list(repo: string) {
    return listWorkspaceRows(repo, false, false);
  },

  async listUnmerged(repo: string) {
    const r = repoOr404(repo);
    const candidates = S.listWorkspaces(r.id).filter(
      (workspace) =>
        workspace.branch !== r.default_branch &&
        localBranchExists(r.local_path, workspace.branch),
    );
    const unmerged = await Promise.all(
      candidates.map((workspace) =>
        hasUnmergedCommits(r.local_path, r.default_branch, workspace.branch),
      ),
    );
    return candidates
      .filter((_workspace, index) => unmerged[index])
      .map((workspace) => workspaceJSON(workspace, true));
  },

  listArchived(repo: string) {
    return listWorkspaceRows(repo, true, false);
  },

  listForSettings(repo: string) {
    return listWorkspaceRows(repo, false, true);
  },

  listArchivedForSettings(repo: string) {
    return listWorkspaceRows(repo, true, true);
  },

  archive(repo: string, branch: string, sessionId?: string | null) {
    return setArchived(repo, branch, true, sessionId);
  },

  unarchive(repo: string, branch: string, sessionId?: string | null) {
    return setArchived(repo, branch, false, sessionId);
  },
};
