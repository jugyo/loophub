import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CodingAgent, configDir, worktreeRoot } from "../config.ts";
import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import {
  aheadBehind,
  branchExists,
  commitDiffFiles,
  currentBranch,
  defaultBranch,
  fetchRemote,
  isGitRepo,
  localBranchRef,
  pullFastForward,
  remoteUrl,
  revParse,
  worktreeListChecked,
} from "../git.ts";
import {
  effectiveMergeMode,
  isGithubRemoteUrl,
  type MergeMode,
  normalizeMergeMode,
} from "../merge-mode.ts";
import { CODING_AGENTS, isCodingAgent } from "../runtimes.ts";
import {
  type RepoAgentConfigWire,
  type RepoGithubPrExportExtraPromptWire,
  type RepoMergeModeWire,
  type RepoOriginSyncWire,
  repoAgentConfigJSON,
  repoGithubPrExportExtraPromptJSON,
  repoJSON,
} from "../serialize.ts";
import * as S from "../store.ts";
import { normalizeGithubPrExportExtraPrompt } from "../workflow/github-pr-export-prompt.ts";
import { worktreePath } from "../worktree-path.ts";
import {
  actorFor,
  canonicalPath,
  ensureWritable,
  repoOr404,
} from "./shared.ts";

export type { Repo } from "../store.ts";

// #71: read the checkout's standing against origin from local refs only. No fetch happens here —
// opening the repo page must not wait on the network — so the counts are as fresh as the last
// fetch/pull. `repos.pullFromOrigin` is what contacts origin, and it returns this same view once
// the pull has updated `refs/remotes/origin/<branch>`.
async function originSyncOf(r: S.Repo): Promise<RepoOriginSyncWire> {
  if (!(await remoteUrl(r.local_path)))
    return { has_origin: false, branch: null, ahead: null, behind: null };
  const branch = await currentBranch(r.local_path);
  const counts = branch
    ? await aheadBehind(
        r.local_path,
        localBranchRef(branch),
        `refs/remotes/origin/${branch}`,
      )
    : null;
  return {
    has_origin: true,
    branch,
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
  };
}

async function originSyncCounts(
  r: S.Repo,
  branch: string,
): Promise<{ branch: string; ahead: number | null; behind: number | null }> {
  const counts = await aheadBehind(
    r.local_path,
    localBranchRef(branch),
    `refs/remotes/origin/${branch}`,
  );
  return {
    branch,
    ahead: counts?.ahead ?? null,
    behind: counts?.behind ?? null,
  };
}

// ===== repos =====
export const repos = {
  async commitFiles(name: string, sha: string) {
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new ServiceError(404, "Not Found");
    const r = repoOr404(name);
    return commitDiffFiles(r.local_path, sha);
  },

  // Thin lookups (by id / by "owner/name") for callers outside core/ that only need the raw row,
  // such as lh-worker event dispatch, which must not import core/store directly.
  getById(id: number): S.Repo | null {
    return S.getRepoById(id);
  },

  async create(
    input: { path: string; name: string },
    sessionId?: string | null,
  ) {
    const { path, name } = input;
    if (!path || !name)
      throw new ServiceError(422, "path and name are required");
    const abs = resolve(path);
    if (!existsSync(abs))
      throw new ServiceError(422, `path does not exist: ${abs}`);
    if (!(await isGitRepo(abs)))
      throw new ServiceError(422, `not a git repository: ${abs}`);
    const [owner, rname] = S.splitName(name);
    if (S.getRepo(owner, rname))
      throw new ServiceError(422, `already registered: ${owner}/${rname}`);
    // The filesystem and git validation above is done; only the registration row and its event are
    // transactional.
    const branch = await defaultBranch(abs);
    return db.transaction(() => {
      const created = S.createRepo(name, abs, branch);
      S.emitEvent(created.id, "repo.created", actorFor(sessionId), {
        full_name: created.full_name,
      });
      return repoJSON(created);
    });
  },

  list(archived: "active" | "archived" | "all" = "active") {
    return S.listRepos(archived).map(repoJSON);
  },

  get(name: string) {
    return repoJSON(repoOr404(name));
  },

  setArchived(name: string, archived: boolean, sessionId?: string | null) {
    if (typeof archived !== "boolean")
      throw new ServiceError(422, "archived must be a boolean");
    const r = repoOr404(name);
    const actor = actorFor(sessionId);
    return db.transaction(() => {
      S.setRepoArchived(r.id, archived);
      S.emitEvent(r.id, archived ? "repo.archived" : "repo.unarchived", actor, {
        full_name: r.full_name,
      });
      return repoJSON(repoOr404(name));
    });
  },

  setFavorite(name: string, favorite: boolean, sessionId?: string | null) {
    if (typeof favorite !== "boolean")
      throw new ServiceError(422, "favorite must be a boolean");
    const r = repoOr404(name);
    const actor = actorFor(sessionId);
    return db.transaction(() => {
      S.setRepoFavorite(r.id, favorite);
      S.emitEvent(
        r.id,
        favorite ? "repo.favorited" : "repo.unfavorited",
        actor,
        { full_name: r.full_name },
      );
      return repoJSON(repoOr404(name));
    });
  },

  // #485: rename a repo's owner/name (full_name). The row keeps its id, so issues/PRs/events
  // follow automatically, and `/r/:owner/:repo` routes plus `--repo owner/name` resolve by
  // full_name per request — both work under the new name immediately. Worktree and dev-lock
  // paths, however, are *derived* from full_name (core/worktree-path.ts, cli/dev.ts
  // devLockPath), so a rename would orphan anything provisioned under the old name; rather
  // than relocating paths, refuse the rename while any worktree or dev lock still lives under
  // the repo's current name. Archived repos stay renamable — like setArchived/setFavorite/
  // setMergeMode, this edits registration metadata, not the repo's contents.
  async rename(name: string, newName: string, sessionId?: string | null) {
    const r = repoOr404(name);
    if (typeof newName !== "string" || !newName.trim())
      throw new ServiceError(422, "new_name must be a non-empty string");
    const trimmed = newName.trim();
    // splitName would silently drop segments past the second; reject instead.
    if (trimmed.split("/").length > 2)
      throw new ServiceError(422, `invalid repo name: ${trimmed}`);
    const [owner, rname] = S.splitName(trimmed);
    const full = `${owner}/${rname}`;
    try {
      // Reuse the worktree-path segment guard as the canonical "safe repo name" check
      // (rejects empty, ".", "..", and backslash segments).
      worktreePath("/", full, 0);
    } catch {
      throw new ServiceError(422, `invalid repo name: ${trimmed}`);
    }
    if (full === r.full_name) return repoJSON(r);
    // Collision check is case- and Unicode-normalization-insensitive: UNIQUE(full_name) is
    // byte-exact, but the derived worktree/dev-lock directories live on filesystems that are
    // commonly case-insensitive and NFC/NFD-normalizing (macOS/Windows), where "acme/app",
    // "Acme/App", and an NFD variant would clobber each other's paths. Exclude the repo
    // itself so a case-only self-rename stays a rename, not a collision.
    const foldName = (s: string) => s.normalize("NFC").toLowerCase();
    const folded = foldName(full);
    const clash = S.listRepos("all").find(
      (other) => other.id !== r.id && foldName(other.full_name) === folded,
    );
    if (clash)
      throw new ServiceError(422, `already registered: ${clash.full_name}`);

    // A git failure must refuse the rename, not read as "no worktrees" — otherwise a
    // moved/corrupt local_path silently bypasses the very orphaning guard below.
    const listed = await worktreeListChecked(r.local_path);
    if (!listed.ok) {
      throw new ServiceError(
        422,
        `cannot rename: cannot verify worktrees (git failed in ${r.local_path}: ${listed.error}); fix local_path first`,
      );
    }
    const base = canonicalPath(join(worktreeRoot(), r.full_name));
    const inUse = listed.worktrees.filter((w) =>
      canonicalPath(w.path).startsWith(`${base}/`),
    );
    if (inUse.length) {
      throw new ServiceError(
        422,
        `cannot rename: ${inUse.length} worktree(s) exist under the current name ` +
          `(${inUse.map((w) => w.path).join(", ")}); ` +
          `merge or close those PRs and remove the worktrees (lh worktree prune) first`,
      );
    }

    // Dev locks are keyed by full_name too (<home>/dev-locks/<full_name>/pr-<n>.json,
    // cli/dev.ts devLockPath) and can exist before the worktree does — a launcher claims the
    // lock first. Refuse while any lock file remains so an in-flight dev session isn't
    // orphaned under the old name; stale lock files must be removed by hand first.
    const lockDir = join(configDir(), "dev-locks", r.full_name);
    const locks = existsSync(lockDir)
      ? readdirSync(lockDir).filter((f) => f.endsWith(".json"))
      : [];
    if (locks.length) {
      throw new ServiceError(
        422,
        `cannot rename: ${locks.length} dev lock(s) exist under the current name ` +
          `(${lockDir}); wait for the dev session to finish or remove stale locks first`,
      );
    }

    // The worktree listing and dev-lock scan above are done; the identity row and its event commit
    // together so a renamed repo always carries the event that records the old name.
    const [oldOwner, oldName] = S.splitName(r.full_name);
    const actor = actorFor(sessionId);
    let updated: S.Repo | null;
    try {
      updated = db.transaction(() => {
        const row = S.updateRepo(oldOwner, oldName, { full_name: full });
        if (row) {
          S.emitEvent(r.id, "repo.renamed", actor, {
            full_name: full,
            from: r.full_name,
          });
        }
        return row;
      });
    } catch (e) {
      // The pre-checks above race against concurrent create/rename calls (async gap at the
      // worktree listing). The byte-exact UNIQUE(full_name) constraint backstops only an
      // identical-name race; a concurrent case/normalization variant slips both checks and
      // is accepted risk for this single-user local tool (closing it would need a
      // COLLATE NOCASE unique index). Normalize the covered race to the same 422 instead of
      // leaking a raw SQLITE_CONSTRAINT error as a 500.
      if (e instanceof Error && /UNIQUE constraint failed/.test(e.message))
        throw new ServiceError(422, `already registered: ${full}`);
      throw e;
    }
    if (!updated) throw new ServiceError(404, "Not Found");
    return repoJSON(updated);
  },

  // #406: pin the repo's PR-detail write action, or clear it back to the remote-based default.
  // `mode` is 'merge' | 'github_pr' (pin) or 'auto' / null (clear). Archived repos stay editable
  // here — the toggle is a config preference, not a write to the repo's contents.
  setMergeMode(
    name: string,
    mode: "merge" | "github_pr" | "auto" | null,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    let stored: MergeMode | null;
    if (mode == null || mode === "auto") {
      stored = null;
    } else if (mode === "merge" || mode === "github_pr") {
      stored = mode;
    } else {
      throw new ServiceError(
        422,
        "mode must be one of: merge, github_pr, auto",
      );
    }
    const actor = actorFor(sessionId);
    return db.transaction(() => {
      S.setRepoMergeMode(r.id, stored);
      S.emitEvent(r.id, "repo.merge_mode_changed", actor, {
        full_name: r.full_name,
        merge_mode: stored,
      });
      return repoJSON(repoOr404(name));
    });
  },

  // #406: resolved merge-mode view for the repo settings UI — the raw stored setting, whether the
  // repo has a GitHub remote, and the effective mode the null default resolves to. Async because the
  // GitHub-remote check shells out to git.
  async mergeMode(name: string): Promise<RepoMergeModeWire> {
    const r = repoOr404(name);
    const has_github_remote = isGithubRemoteUrl(await remoteUrl(r.local_path));
    return {
      setting: normalizeMergeMode(r.merge_mode),
      has_github_remote,
      effective: effectiveMergeMode(r.merge_mode, has_github_remote),
    };
  },

  // #71: origin sync state for the repo-top sidebar — whether the repo has an origin at all, the
  // checked-out branch, and how far it is ahead of / behind `origin/<branch>`.
  async originSync(name: string): Promise<RepoOriginSyncWire> {
    return originSyncOf(repoOr404(name));
  },

  // #71: `git pull --ff-only origin <branch>` in the registered checkout, answering with the
  // refreshed sync state. Every way this can fail — no origin, a detached HEAD, a diverged or
  // dirty branch, an unreachable remote — is reported with git's own message rather than retried
  // or worked around: the operator sees what git said and decides what to do next.
  async pullFromOrigin(name: string): Promise<RepoOriginSyncWire> {
    const r = repoOr404(name);
    ensureWritable(r);
    if (!(await remoteUrl(r.local_path)))
      throw new ServiceError(422, "no origin remote is configured");
    const branch = await currentBranch(r.local_path);
    if (!branch)
      throw new ServiceError(422, "cannot pull while HEAD is detached");
    const pulled = await pullFastForward(r.local_path, branch);
    if (pulled.code !== 0) {
      const detail =
        pulled.stderr.trim() || pulled.stdout.trim() || "unknown error";
      throw new ServiceError(
        422,
        `git pull --ff-only origin ${branch} failed: ${detail}`,
      );
    }
    const sync = await originSyncCounts(r, branch);
    db.transaction(() => S.setRepoOriginSync(r.id, sync));
    return originSyncOf(repoOr404(name));
  },

  // Refresh the checkout's view of origin: `git fetch origin` updates the remote-tracking refs the
  // originSync read above derives its counts from, answering with the refreshed sync state. Unlike
  // pullFromOrigin this never touches the working tree or the checked-out branch, so it is safe on a
  // detached HEAD and leaves issue/PR grouping and bases untouched. Every way it can fail — no
  // origin, an unreachable remote — is reported with git's own message rather than retried.
  async fetchFromOrigin(name: string): Promise<RepoOriginSyncWire> {
    const r = repoOr404(name);
    if (!(await remoteUrl(r.local_path)))
      throw new ServiceError(422, "no origin remote is configured");
    const fetched = await fetchRemote(r.local_path);
    if (fetched.code !== 0) {
      const detail =
        fetched.stderr.trim() || fetched.stdout.trim() || "unknown error";
      throw new ServiceError(422, `git fetch origin failed: ${detail}`);
    }
    const branch = await currentBranch(r.local_path);
    if (branch) {
      const sync = await originSyncCounts(r, branch);
      db.transaction(() => S.setRepoOriginSync(r.id, sync));
    }
    return originSyncOf(repoOr404(name));
  },

  // #1532: set (or clear) the repo's Coding agent override. `override` toggles whether the repo's
  // own runtime / model / effort win over the application defaults; the three values are stored
  // regardless so re-enabling the toggle restores them. Archived repos stay editable — like
  // setMergeMode, this is a config preference, not a write to the repo's contents.
  setAgentConfig(
    name: string,
    input: {
      override: boolean;
      runtime?: string | null;
      model?: string | null;
      effort?: string | null;
    },
    sessionId?: string | null,
  ): RepoAgentConfigWire {
    const r = repoOr404(name);
    if (typeof input.override !== "boolean") {
      throw new ServiceError(422, "override must be a boolean");
    }
    // A runtime, when given, must be a known coding agent. model / effort are free-form strings the
    // launched runtime interprets (mirrors settings/update); an empty string is normalized to null.
    if (
      input.runtime != null &&
      !isCodingAgent(input.runtime as CodingAgent | undefined)
    ) {
      throw new ServiceError(
        422,
        `runtime must be one of: ${CODING_AGENTS.join(", ")}`,
      );
    }
    const normalizeText = (value: string | null | undefined): string | null => {
      if (value == null) return null;
      if (typeof value !== "string") {
        throw new ServiceError(422, "model and effort must be strings");
      }
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    };
    db.transaction(() => {
      S.setRepoAgentConfig(r.id, {
        override: input.override,
        runtime: (input.runtime as CodingAgent | null | undefined) ?? null,
        model: normalizeText(input.model),
        effort: normalizeText(input.effort),
      });
      S.emitEvent(r.id, "repo.agent_config_changed", actorFor(sessionId), {
        full_name: r.full_name,
        override: input.override,
      });
    });
    // Serialized outside the transaction: the effective config resolves the application defaults
    // from config.json, which is a filesystem read.
    return repoAgentConfigJSON(repoOr404(name));
  },

  // #1532: resolved Coding agent view for the repo settings UI — the raw stored override (toggle +
  // values as entered) and the effective config a workflow run launches with (repo override when on,
  // else the application defaults). Sync: the effective resolution reads config.json, not git.
  agentConfig(name: string): RepoAgentConfigWire {
    return repoAgentConfigJSON(repoOr404(name));
  },

  // #2422: read the repo's optional additional "Create PR on GitHub" prompt text.
  githubPrExportExtraPrompt(name: string): RepoGithubPrExportExtraPromptWire {
    return repoGithubPrExportExtraPromptJSON(repoOr404(name));
  },

  // #2422: set or clear the repo's additional "Create PR on GitHub" prompt. Empty / null clears so
  // launches use only the default template. Archived repos stay editable — like setMergeMode, this
  // is a config preference, not a write to the repo's contents.
  setGithubPrExportExtraPrompt(
    name: string,
    extraPrompt: string | null,
    sessionId?: string | null,
  ): RepoGithubPrExportExtraPromptWire {
    const r = repoOr404(name);
    if (extraPrompt != null && typeof extraPrompt !== "string") {
      throw new ServiceError(422, "extra_prompt must be a string or null");
    }
    const stored = normalizeGithubPrExportExtraPrompt(extraPrompt);
    return db.transaction(() => {
      S.setRepoGithubPrExportExtraPrompt(r.id, stored);
      S.emitEvent(
        r.id,
        "repo.github_pr_export_extra_prompt_changed",
        actorFor(sessionId),
        {
          full_name: r.full_name,
          has_extra_prompt: stored != null,
        },
      );
      return repoGithubPrExportExtraPromptJSON(repoOr404(name));
    });
  },

  async update(
    name: string,
    fields: { default_branch?: string; local_path?: string },
    _sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const { default_branch, local_path } = fields;
    if (default_branch === undefined && local_path === undefined) {
      throw new ServiceError(
        422,
        "at least one of default_branch or local_path is required",
      );
    }

    let resolvedPath: string | undefined;
    if (local_path !== undefined) {
      if (typeof local_path !== "string" || !local_path.trim()) {
        throw new ServiceError(422, "local_path must be a non-empty string");
      }
      resolvedPath = resolve(local_path);
      if (!existsSync(resolvedPath))
        throw new ServiceError(422, `path does not exist: ${resolvedPath}`);
      if (!(await isGitRepo(resolvedPath)))
        throw new ServiceError(422, `not a git repository: ${resolvedPath}`);
    }

    const targetPath = resolvedPath ?? r.local_path;
    if (default_branch !== undefined) {
      if (typeof default_branch !== "string" || !default_branch.trim()) {
        throw new ServiceError(
          422,
          "default_branch must be a non-empty string",
        );
      }
      if (!(await branchExists(targetPath, default_branch))) {
        throw new ServiceError(422, `branch not found: ${default_branch}`);
      }
    } else if (resolvedPath !== undefined) {
      if (!(await branchExists(targetPath, r.default_branch))) {
        throw new ServiceError(422, `branch not found: ${r.default_branch}`);
      }
    }

    let headShas: { issueId: number; sha: string | null }[] | undefined;
    if (resolvedPath !== undefined) {
      headShas = [];
      for (const p of S.listOpenPullsForRepo(r.id)) {
        headShas.push({
          issueId: p.issue_id,
          sha: await revParse(resolvedPath, localBranchRef(p.head_ref)),
        });
      }
    }

    const [owner, rname] = S.splitName(name);
    const updated = S.updateRepo(
      owner,
      rname,
      { default_branch, local_path: resolvedPath },
      headShas,
    );
    if (!updated) throw new ServiceError(404, "Not Found");
    return repoJSON(updated);
  },

  // The repository and worktree checkouts on disk are deliberately left alone; only the registry
  // rows go, and they go together — a half-removed repo would leave orphan issues and events behind.
  remove(name: string) {
    const [owner, rname] = S.splitName(name);
    if (!S.getRepo(owner, rname)) throw new ServiceError(404, "Not Found");
    db.transaction(() => {
      S.deleteRepo(owner, rname);
    });
  },
};
