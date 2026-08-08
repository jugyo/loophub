import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
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

function setArchived(
  repo: string,
  branch: string,
  archived: boolean,
  sessionId?: string | null,
) {
  const r = repoOr404(repo);
  workspaceOr404(r.id, branch);
  const workspace = db.transaction(() => {
    S.setWorkspaceArchived(r.id, branch, archived);
    const updated = workspaceOr404(r.id, branch);
    S.emitEvent(
      r.id,
      archived ? "workspace.archived" : "workspace.unarchived",
      actorFor(sessionId),
      { branch },
    );
    return updated;
  });
  // The branch existence check shells out to git, so it stays outside the transaction.
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
    // An existing branch is registered as-is; only a missing branch is created
    // from the default branch. The git side happens first, and only the registry
    // row and its event are transactional.
    ensureLocalBranchFromDefault(
      r.local_path,
      branch,
      r.default_branch,
      "workspace branch",
    );
    const workspace = db.transaction(() => {
      const created = S.createWorkspace(r.id, branch);
      S.emitEvent(r.id, "workspace.created", actorFor(sessionId), { branch });
      return created;
    });
    return workspaceJSON(workspace, true);
  },

  list(repo: string) {
    return listWorkspaceRows(repo, false, false);
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
