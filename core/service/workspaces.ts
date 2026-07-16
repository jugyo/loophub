import { workspaceJSON } from "../serialize.ts";
import {
  actorFor,
  assertCreatableLocalBranchName,
  ensureLocalBranchFromDefault,
  ensureWritable,
  localBranchExists,
  repoOr404,
  S,
  ServiceError,
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

export const workspaces = {
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
    const r = repoOr404(repo);
    return S.listWorkspaces(r.id).map((workspace) =>
      workspaceJSON(
        workspace,
        localBranchExists(r.local_path, workspace.branch),
      ),
    );
  },

  listArchived(repo: string) {
    const r = repoOr404(repo);
    return S.listArchivedWorkspaces(r.id).map((workspace) =>
      workspaceJSON(
        workspace,
        localBranchExists(r.local_path, workspace.branch),
      ),
    );
  },

  archive(repo: string, branch: string, sessionId?: string | null) {
    return setArchived(repo, branch, true, sessionId);
  },

  unarchive(repo: string, branch: string, sessionId?: string | null) {
    return setArchived(repo, branch, false, sessionId);
  },
};
