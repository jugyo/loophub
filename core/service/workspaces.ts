import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { git, localBranchRef, mergeBase, mergePreview } from "../git.ts";
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

async function blobOid(
  repoPath: string,
  rev: string,
  path: string,
): Promise<string | null> {
  const result = await git(repoPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${rev}:${path}`,
  ]);
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

async function blobContent(
  repoPath: string,
  rev: string,
  path: string,
): Promise<string> {
  const result = await git(repoPath, ["show", `${rev}:${path}`]);
  if (result.code !== 0) return "";
  return result.stdout;
}

// True when workspace-side changes since the merge-base still contribute content that
// is not already on default. A pure tip conflict (both sides rewrote the same region
// after the work landed elsewhere) is not enough: only a clean 3-way merge whose
// result differs from default counts as net-new. That is what hides long-lived
// integration branches such as a squash-landed `opencode` tip that still conflicts
// on an unrelated README rewrite.
async function hasNetNewWorkspaceContent(
  repoPath: string,
  defaultRef: string,
  workspaceRef: string,
): Promise<boolean> {
  const base = await mergeBase(repoPath, defaultRef, workspaceRef);
  if (!base) return true;

  const names = await git(repoPath, [
    "diff",
    "--name-only",
    base,
    workspaceRef,
  ]);
  if (names.code !== 0) {
    throw new Error(
      names.stderr.trim() ||
        names.stdout.trim() ||
        "git diff --name-only failed",
    );
  }
  const files = names.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (files.length === 0) return false;

  const dir = mkdtempSync(join(tmpdir(), "lh-ws-netnew-"));
  const mainPath = join(dir, "main");
  const basePath = join(dir, "base");
  const workspacePath = join(dir, "workspace");
  try {
    for (const file of files) {
      const [mainOid, workspaceOid] = await Promise.all([
        blobOid(repoPath, defaultRef, file),
        blobOid(repoPath, workspaceRef, file),
      ]);
      if (mainOid === workspaceOid) continue;

      const [mainContent, baseContent, workspaceContent] = await Promise.all([
        blobContent(repoPath, defaultRef, file),
        blobContent(repoPath, base, file),
        blobContent(repoPath, workspaceRef, file),
      ]);
      writeFileSync(mainPath, mainContent);
      writeFileSync(basePath, baseContent);
      writeFileSync(workspacePath, workspaceContent);

      // merge-file is pure path IO; -C repo is harmless and keeps one git helper.
      const merged = await git(repoPath, [
        "merge-file",
        "-p",
        mainPath,
        basePath,
        workspacePath,
      ]);
      if (merged.code > 1) {
        // Binary / unreadable merge — treat as still carrying unique work.
        return true;
      }
      if (merged.code === 1) {
        // Conflict alone is not net-new; default may have moved past a landed tip.
        continue;
      }
      if (merged.stdout !== readFileSync(mainPath, "utf8")) {
        return true;
      }
    }
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// True when the workspace still carries work that is not already present on the default
// branch. Ancestry alone (`default..workspace`) is not enough: squash merges and re-landed
// commits leave SHAs only on the workspace tip even when default already has the same
// tree outcome. After the cheap ancestry check, a clean merge-tree decides whether landing
// the workspace would change default's tree. On conflict, fall back to per-file net-new
// content so stale integration tips that only conflict with later default edits are hidden.
async function hasUnmergedCommits(
  repoPath: string,
  defaultBranch: string,
  workspaceBranch: string,
): Promise<boolean> {
  const defaultRef = localBranchRef(defaultBranch);
  const workspaceRef = localBranchRef(workspaceBranch);
  const compareFailure = (detail: string) =>
    new ServiceError(
      500,
      `failed to compare workspace branch "${workspaceBranch}" with default branch "${defaultBranch}": ${detail}`,
    );

  const countResult = await git(repoPath, [
    "rev-list",
    "--count",
    `${defaultRef}..${workspaceRef}`,
  ]);
  if (countResult.code !== 0) {
    throw compareFailure(
      countResult.stderr.trim() ||
        countResult.stdout.trim() ||
        "git rev-list failed",
    );
  }
  if (Number(countResult.stdout.trim()) === 0) {
    return false;
  }

  try {
    const [preview, treeResult] = await Promise.all([
      mergePreview(repoPath, defaultRef, workspaceRef),
      git(repoPath, ["rev-parse", `${defaultRef}^{tree}`]),
    ]);
    if (treeResult.code !== 0) {
      throw new Error(
        treeResult.stderr.trim() ||
          treeResult.stdout.trim() ||
          "git rev-parse failed",
      );
    }
    const defaultTree = treeResult.stdout.trim();
    if (!preview.conflict) {
      if (!preview.tree) return true;
      // Clean merge that leaves default's tree unchanged → content already integrated.
      return preview.tree !== defaultTree;
    }
    // Conflict: do not treat tip divergence alone as unmerged. Ask whether workspace
    // changes still contribute cleanly-applicable content that default lacks.
    return hasNetNewWorkspaceContent(repoPath, defaultRef, workspaceRef);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw compareFailure(detail);
  }
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
