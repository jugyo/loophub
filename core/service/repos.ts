import type { MergeMode } from "./shared.ts";
import {
  actorFor,
  branchExists,
  canonicalPath,
  configDir,
  defaultBranch,
  effectiveMergeMode,
  ensureWritable,
  existsSync,
  isGithubRemoteUrl,
  isGitRepo,
  join,
  normalizeMergeMode,
  readdirSync,
  remoteUrl,
  repoJSON,
  repoOr404,
  resolve,
  revParse,
  S,
  ServiceError,
  worktreeListChecked,
  worktreePath,
  worktreeRoot,
} from "./shared.ts";

export type { Repo } from "../store.ts";

// ===== repos =====
export const repos = {
  // Thin lookups (by id / by "owner/name") for callers outside core/ that only need the raw row,
  // such as lh-worker event dispatch, which must not import core/store directly.
  getById(id: number): S.Repo | null {
    return S.getRepoById(id);
  },

  // Raw split, not S.splitName: splitName defaults an owner-less name to "me/<name>", which
  // would silently change exact repo-filter matching for callers that pass an unslashed name.
  getByFullName(fullName: string): S.Repo | null {
    const [owner, name] = fullName.split("/");
    return S.getRepo(owner, name);
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
    const branch = await defaultBranch(abs);
    const created = S.createRepo(name, abs, branch);
    S.emitEvent(created.id, "repo.created", actorFor(sessionId), {
      full_name: created.full_name,
    });
    return repoJSON(created);
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
    S.setRepoArchived(r.id, archived);
    S.emitEvent(r.id, archived ? "repo.archived" : "repo.unarchived", actor, {
      full_name: r.full_name,
    });
    return repoJSON(repoOr404(name));
  },

  setFavorite(name: string, favorite: boolean, sessionId?: string | null) {
    if (typeof favorite !== "boolean")
      throw new ServiceError(422, "favorite must be a boolean");
    const r = repoOr404(name);
    const actor = actorFor(sessionId);
    S.setRepoFavorite(r.id, favorite);
    S.emitEvent(r.id, favorite ? "repo.favorited" : "repo.unfavorited", actor, {
      full_name: r.full_name,
    });
    return repoJSON(repoOr404(name));
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
    // cli/dev.ts devLockPath) and can exist before the worktree does — `lh build` claims the
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

    const [oldOwner, oldName] = S.splitName(r.full_name);
    let updated: S.Repo | null;
    try {
      updated = S.updateRepo(oldOwner, oldName, { full_name: full });
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
    const actor = actorFor(sessionId);
    S.emitEvent(r.id, "repo.renamed", actor, {
      full_name: full,
      from: r.full_name,
    });
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
    S.setRepoMergeMode(r.id, stored);
    S.emitEvent(r.id, "repo.merge_mode_changed", actor, {
      full_name: r.full_name,
      merge_mode: stored,
    });
    return repoJSON(repoOr404(name));
  },

  // #406: resolved merge-mode view for the repo settings UI — the raw stored setting, whether the
  // repo has a GitHub remote, and the effective mode the null default resolves to. Async because the
  // GitHub-remote check shells out to git.
  async mergeMode(name: string) {
    const r = repoOr404(name);
    const has_github_remote = isGithubRemoteUrl(await remoteUrl(r.local_path));
    return {
      setting: normalizeMergeMode(r.merge_mode),
      has_github_remote,
      effective: effectiveMergeMode(r.merge_mode, has_github_remote),
    };
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
          sha: await revParse(resolvedPath, p.head_ref),
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

  remove(name: string) {
    const [owner, rname] = S.splitName(name);
    if (!S.getRepo(owner, rname)) throw new ServiceError(404, "Not Found");
    S.deleteRepo(owner, rname);
  },
};
