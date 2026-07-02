// Service layer: transport-neutral procedures over the store. Each procedure validates
// input (throwing ServiceError with an HTTP-style status), mutates the store, emits
// events, and returns serialized wire objects. The CLI calls these directly (S5); the
// JSON-RPC layer (S2) will wrap the same procedures. No HTTP/Request types leak in here.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  autoModeOnBuild,
  type CodingAgent,
  codingAgent,
  configDir,
  terminalLaunchBackend,
  updateConfig,
  worktreeRoot,
} from "./config.ts";
import { isServiceError, ServiceError } from "./errors.ts";
import { formatEvent, type LoopEvent } from "./event-hub.ts";
import { type FollowOptions, followEvents } from "./events-follow.ts";
import {
  branchExists,
  commitLog,
  commitsAhead,
  defaultBranch,
  diffFiles,
  diffStat,
  fileAtRef,
  mergePull as gitMergePull,
  isGitRepo,
  pathInDiff,
  remoteUrl,
  revParse,
  worktreeList,
  worktreeListChecked,
  worktreePrune,
  worktreeRemove,
  worktreeStatus,
} from "./git.ts";
import { type GithubDeps, realGithubDeps } from "./github.ts";
import {
  type HerdrAgent,
  NO_PANE_ID_PREFIX,
  parseHerdrAgentList,
  parseHerdrAgentRead,
  parseHerdrPaneLayout,
  parseHerdrSessionList,
  reposWithRunningSession,
} from "./herdr-status.ts";
import { parseClosingIssueNumber } from "./links.ts";
import {
  effectiveMergeMode,
  isGithubRemoteUrl,
  type MergeMode,
  normalizeMergeMode,
  parseGithubPullNumber,
} from "./merge-mode.ts";
import {
  decideResume,
  RUNTIME_CLAUDE_CODE,
  resolveRuntimeResume,
  resolveWorktreeIdentity,
  sessionRuntime,
} from "./resume.ts";
import {
  isRetroStatus,
  RetroValidationError,
  validateFindings,
  validateRubric,
} from "./retro.ts";
import {
  agentSessionJSON,
  commentJSON,
  githubPullJSON,
  handoffJSON,
  issueGroupJSON,
  issueJSON,
  issueListItemJSON,
  labelJSON,
  pullJSON,
  relatedSessionsJSON,
  repoJSON,
  retroJSON,
  reviewCommentJSON,
  reviewJSON,
  reviewNoteJSON,
} from "./serialize.ts";
import * as S from "./store.ts";
import {
  buildHerdrLaunchPlan,
  commandForHerdrLaunch,
  HERDR_ID,
  herdrCommandLine,
  herdrPaneCloseArgv,
  herdrSessionName,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrTabCreateInWorkspaceArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceCreateArgv,
  herdrWorkspaceFocusArgv,
  herdrWorktreeOpenArgv,
  parseHerdrRootPaneId,
  parseHerdrTabId,
  parseHerdrWorkspaceId,
  parseHerdrWorktreeOpenResult,
  type TerminalLaunchBackend,
  type TerminalLaunchRepo,
} from "./terminal-launch.ts";
import { sweepPullUpdates } from "./watcher.ts";
import {
  legacyWorktreePath,
  worktreeBranch,
  worktreePath,
} from "./worktree-path.ts";
import { provisionWorktree } from "./worktree-provision.ts";
import {
  classifyWorktree,
  issueNumberFromBranch,
  porcelainIsDirty,
  prNumberFromBranch,
} from "./worktree-prune.ts";

export const MAX_EVENTS_PER_PAGE = 100;
export const DEFAULT_LIST_PER_PAGE = 30;
export const MAX_LIST_PER_PAGE = 100;

export interface TerminalLaunchInput {
  repo: string;
  label?: string;
  workflow?: "issue-dev" | "issue-create" | "resume" | "github-pr-export";
  issueNumber?: number;
  prNumber?: number;
  session?: string;
  cwd?: string;
}

// ---- shared helpers ----
function repoOr404(name: string): S.Repo {
  const [owner, rname] = S.splitName(name);
  const r = S.getRepo(owner, rname);
  if (!r) throw new ServiceError(404, "Not Found");
  return r;
}

function ensureWritable(r: S.Repo): void {
  if (S.isArchived(r)) throw new ServiceError(403, "Repository is archived");
}

function actorFor(sessionId: string | null | undefined): string {
  return S.authorFromSession(sessionId) ?? "unknown";
}

// Resolve symlinks so worktree paths from `git worktree list` (which canonicalizes, e.g.
// /var → /private/var on macOS) compare equal to a caller's cwd. Falls back to a plain
// absolute path when the target no longer exists.
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function issueOr404(r: S.Repo, number: number, kind?: "issue" | "pull"): any {
  const row = S.getIssue(r.id, number);
  if (!row || (kind && row.kind !== kind))
    throw new ServiceError(404, "Not Found");
  return row;
}

function clampPerPage(
  perPage: number | undefined,
  def: number,
  max: number,
): number {
  let v = Number(perPage ?? def);
  if (!Number.isFinite(v) || v < 1) v = def;
  return Math.min(v, max);
}

function paginate<T>(rows: T[], perPage: number, page: number): T[] {
  const offset = (page - 1) * perPage;
  return rows.slice(offset, offset + perPage);
}

// ===== repos =====
export const repos = {
  async create(input: { path: string; name: string }) {
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
    return repoJSON(S.createRepo(name, abs, branch));
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
    // cli/dev.ts devLockPath) and can exist before the worktree does — `lh dev` claims the
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

// The expected `herdr tab create` output is one small JSON object; anything past this cap is
// discarded so a misbehaving herdr streaming output can't grow lh-web memory unbounded.
const HERDR_CAPTURE_MAX_BYTES = 64 * 1024;

// Spawns Herdr asynchronously (never spawnSync — this runs inside the lh-web server process,
// which also serves SSE/WebSocket terminals for every other client). Errors are deliberately
// generic: the underlying stderr/stdout (or an OS error message) can embed the repo's absolute
// local_path, mirroring web/server/terminal.ts's closeReasonFor rationale for not forwarding
// internal process output to the client. Resolves with the drained stdout when captureStdout
// is set, "" otherwise.
function runHerdr(
  command: string,
  args: string[],
  cwd: string,
  opts: { captureStdout?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdio defaults to all "ignore": the client never sees stdout/stderr (see the comment
    // above), and a "pipe" nobody drains would let the child's writes fill the OS pipe buffer
    // and block forever (no `close` event, an indefinitely hanging RPC call) — or crash the
    // whole lh-web process on an unhandled stream error. captureStdout pipes stdout but always
    // drains it (and handles its `error` event below, so a stream error can't crash lh-web).
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", opts.captureStdout ? "pipe" : "ignore", "ignore"],
    });
    // Settle-once guard: the success path settles on `close` (all output drained), but the
    // timeout path settles immediately — `close` waits for the stdout pipe to shut, and a
    // descendant process that inherited the pipe fd can hold it open past herdr's own death,
    // which would leave the promise pending forever (and wedge terminal.sessions' coalescing
    // slot until a server restart).
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Guards the awaiting RPC call against a herdr client that never exits (e.g. wedged on its
    // session socket): kill and reject right away (see the settle-once comment above).
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          settle(() =>
            reject(
              new ServiceError(
                500,
                `Herdr timed out after ${opts.timeoutMs}ms`,
              ),
            ),
          );
        }, opts.timeoutMs)
      : undefined;
    const chunks: Buffer[] = [];
    let captured = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (captured >= HERDR_CAPTURE_MAX_BYTES) return; // keep draining, stop keeping
      chunks.push(chunk);
      captured += chunk.length;
    });
    child.stdout?.on("error", () => {
      // Losing the output stream only means the tab id can't be read; the `close` handler
      // still decides success/failure, so just stop the error from being unhandled.
    });
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      settle(() =>
        reject(
          code === "ENOENT"
            ? new ServiceError(422, "herdr command not found on PATH")
            : new ServiceError(
                500,
                `failed to launch Herdr (${code ?? "spawn error"})`,
              ),
        ),
      );
    });
    child.on("close", (status, signal) => {
      // `status` is null when the child was terminated by a signal rather than exiting on its
      // own — treat that as a failure too, instead of `?? 0` collapsing a null code to success.
      // The distinction (signal vs. exit code) is itself a safe, non-leaky hint about *why* the
      // launch failed, so surface it instead of one generic "Herdr launch failed" for both.
      settle(() => {
        if (signal == null && status === 0)
          resolve(Buffer.concat(chunks).toString("utf8"));
        else if (signal != null)
          reject(
            new ServiceError(
              500,
              `Herdr process was terminated by signal ${signal}`,
            ),
          );
        else
          reject(new ServiceError(500, `Herdr exited with status ${status}`));
      });
    });
  });
}

function runHerdrLaunch(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return runHerdr(command, args, cwd).then(() => {});
}

// Herdr query command for the sidebar status sweep (#495): capture stdout with a hard
// timeout. Rides on runHerdr so the spawn/capture-cap/error semantics stay in one place;
// callers treat any rejection as "no data". The cwd is irrelevant to `herdr session list` /
// `agent list`, so the server's own cwd will do.
function runHerdrCapture(args: string[]): Promise<string> {
  return runHerdr("herdr", args, process.cwd(), {
    captureStdout: true,
    timeoutMs: 10_000,
  });
}

export interface HerdrRepoSessions {
  repo: string;
  session_name: string;
  agents: HerdrAgent[];
}

// Coalesces concurrent terminal.sessions calls onto one herdr sweep. Every client polls this
// RPC (15s interval per tab), so without sharing, N tabs would each spawn their own
// `herdr session list` + per-repo `agent list` process trees against the same state.
let herdrSessionsInflight: Promise<{ repos: HerdrRepoSessions[] }> | null =
  null;

// Resolves the on-disk worktree path herdr's `worktree open` should target for a launch (#551),
// so herdr's own workspace/worktree metadata is pinned to the PR's real worktree instead of a
// plain tab the launched command cd's into. Best-effort: returns null when the workflow has no
// worktree (issue-create) or resolving/provisioning it fails for any reason — the caller falls
// back to the plain repo-root tab-create, same as any other herdr failure.
//
// issue-dev's Build button always fires before a PR exists (it's hidden once one is open), so the
// PR — and its deterministic worktree path (#463) — is opened/provisioned right here, ahead of the
// herdr launch. dev.openPr and provisionWorktree are both idempotent, so this mirrors (and is
// safely re-done by) the same calls `lh dev <issue>` makes for itself once it starts running
// inside the tab this resolves.
async function resolveHerdrWorktreeTarget(
  r: S.Repo,
  input: TerminalLaunchInput,
): Promise<string | null> {
  try {
    if (input.workflow === "issue-dev" && input.issueNumber) {
      const opened = await dev.openPr(r.full_name, {
        issue: input.issueNumber,
        base: r.default_branch,
      });
      const prRow = issueOr404(r, opened.number, "pull");
      const headRef = S.getPull(prRow.id).head_ref;
      return await provisionWorktree({
        repoPath: r.local_path,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        worktreeRoot: worktreeRoot(),
        pr: opened.number,
        headRef,
        allowCreatingConventionBranch: opened.created,
      });
    }
    if (input.workflow === "resume") {
      // The client already resolved the PR's worktree path (issue/pull detail's worktree_path,
      // #345); an issue-create session (no worktree) omits cwd and resumes from the repo root
      // instead, which is exactly what the repo-root tab-create fallback gives it.
      return input.cwd ?? null;
    }
    if (input.workflow === "github-pr-export" && input.prNumber) {
      const prRow = issueOr404(r, input.prNumber, "pull");
      const headRef = S.getPull(prRow.id).head_ref;
      const identity = resolveWorktreeIdentity(headRef, input.prNumber);
      return identity.scheme === "legacy-issue"
        ? legacyWorktreePath(worktreeRoot(), r.full_name, identity.number)
        : worktreePath(worktreeRoot(), r.full_name, identity.number);
    }
  } catch {
    // Repo not writable, issue/PR not found, worktree provisioning error, … — none of these
    // should fail the launch itself, only mean herdr won't get worktree metadata for it.
  }
  return null;
}

// Opens (or reuses) the herdr workspace pinned to `worktreeCheckoutPath` and returns a tab safe
// to pass to `agent start --tab`. A *first-time* open creates a brand-new single-tab workspace —
// structurally identical to `herdr workspace create` (#544) — whose sole tab herdr refuses to
// close via `tab close` (it would be the workspace's last one), so `workspaceId` is populated in
// that case for the caller to use `herdr workspace close` instead, exactly like the isNewWorkspace
// path in terminal.launch. A *reused* workspace's own tab may already be in active use (someone
// else's pane), so that case opens a genuinely new (safely closeable) tab inside it instead of
// treating the existing one as an empty placeholder — see herdrTabCreateInWorkspaceArgv;
// `workspaceId` is null there since the workspace itself isn't this call's to close. Returns null
// only when the initial `worktree open` itself fails outright (worktree_not_found, timeout, …) or
// its output is unparseable — nothing was created, so the caller falls back to the plain
// repo-root tab-create. A partial success (e.g. the tab id itself fails to parse) still returns
// an object so `workspaceId` reaches the caller's orphan-cleanup path instead of being lost.
async function acquireHerdrWorktreeTab(
  repo: TerminalLaunchRepo,
  cwd: string,
  worktreeCheckoutPath: string,
): Promise<{
  tabId: string | null;
  rootPaneId: string | null;
  workspaceId: string | null;
  createdWorkspace: boolean;
} | null> {
  try {
    const open = herdrWorktreeOpenArgv(repo, worktreeCheckoutPath);
    const out = await runHerdr(open[0], open.slice(1), cwd, {
      captureStdout: true,
      timeoutMs: 10_000,
    });
    const opened = parseHerdrWorktreeOpenResult(out);
    if (!opened) return null;
    if (!opened.alreadyOpen) {
      return {
        tabId: parseHerdrTabId(out),
        rootPaneId: parseHerdrRootPaneId(out),
        workspaceId: opened.workspaceId,
        createdWorkspace: true,
      };
    }
    if (!opened.workspaceId) return null;
    const tabCreate = herdrTabCreateInWorkspaceArgv(
      repo,
      opened.workspaceId,
      worktreeCheckoutPath,
    );
    const tabOut = await runHerdr(tabCreate[0], tabCreate.slice(1), cwd, {
      captureStdout: true,
      timeoutMs: 10_000,
    });
    return {
      tabId: parseHerdrTabId(tabOut),
      rootPaneId: parseHerdrRootPaneId(tabOut),
      // The reused workspace already existed before this call, so it is not this launch's to
      // close on failure — only the freshly added tab (if its id parsed) is.
      workspaceId: null,
      createdWorkspace: false,
    };
  } catch {
    return null;
  }
}

// ===== terminal launch =====
export const terminal = {
  config(): { backend: TerminalLaunchBackend } {
    return { backend: terminalLaunchBackend() };
  },

  async launch(input: TerminalLaunchInput) {
    if (!input.repo) throw new ServiceError(422, "repo is required");
    const backend = terminalLaunchBackend();
    if (backend === "builtin") return { backend };

    const r = repoOr404(input.repo);
    const command = commandForHerdrLaunch({
      repo: r.full_name,
      workflow: input.workflow,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      session: input.session,
      cwd: input.cwd,
      // Auto mode only applies to the Build button's issue-dev launch (#499), not other
      // terminal workflows (issue-create, resume, github-pr-export).
      auto: input.workflow === "issue-dev" && autoModeOnBuild(),
    });
    if (!command.trim()) throw new ServiceError(422, "command is required");

    const repo = { full_name: r.full_name, local_path: r.local_path };
    // New Issue gets its own fresh workspace instead of a tab in the repo's existing default
    // workspace (#544) — it has no worktree to pin to. The worktree-backed workflows
    // (Build/issue-dev, resume, github-pr-export) instead open a workspace pinned to the PR's
    // real worktree (#551, below). `herdr workspace create` seeds the workspace with one tab
    // and one empty pane in the same output shape `herdr tab create` uses, so the tab/root-pane
    // parsing below is unchanged either way.
    const isNewWorkspace = input.workflow === "issue-create";
    // Create a fresh tab (or workspace) first so the agent starts in it instead of splitting the
    // focused pane (#489). Best-effort: on any failure fall back to the tab-less launch (Herdr's
    // default split placement) rather than breaking the launch; a hard herdr failure still
    // surfaces from the agent start below. The timeout keeps a wedged herdr call from hanging
    // the RPC forever — runHerdr kills it and the catch falls back.
    let tabId: string | null = null;
    // The seed tab's root pane (from `worktree open`, its follow-up `tab create --workspace`, or
    // the plain repo-root `tab create`) is an empty default pane; `agent start --tab` below
    // splits alongside it instead of replacing it, leaving it behind (#503) unless the launch
    // closes it once the agent's own pane exists. Captured from the same output as tabId, so
    // it's only ever set together with a usable tabId.
    let rootPaneId: string | null = null;
    // Set whenever this launch is responsible for a whole *fresh* single-tab workspace — the
    // issue-create `workspace create` path, or a first-time worktree `worktree open` (#551,
    // acquireHerdrWorktreeTab's createdWorkspace) — used to close the whole workspace (not just
    // the tab) if the agent fails to start, since herdr refuses to close a workspace's last
    // remaining tab. Parsed independently from tabId out of the same response, so it is NOT
    // guaranteed to succeed/fail together with it — the cleanup below must handle either one
    // being null while the other is set. Not set when a worktree's workspace was merely *reused*
    // (acquireHerdrWorktreeTab's already-open branch) — that workspace predates this launch and
    // isn't this launch's to close.
    let workspaceId: string | null = null;
    let createdWorkspace = false;
    try {
      if (isNewWorkspace) {
        const create = herdrWorkspaceCreateArgv(repo);
        const out = await runHerdr(create[0], create.slice(1), r.local_path, {
          captureStdout: true,
          timeoutMs: 10_000,
        });
        tabId = parseHerdrTabId(out);
        rootPaneId = parseHerdrRootPaneId(out);
        workspaceId = parseHerdrWorkspaceId(out);
        createdWorkspace = true;
      } else {
        // Worktree-backed workflows (issue-dev/resume/github-pr-export, #551) open the herdr
        // workspace directly at the PR's real worktree path, so herdr's own workspace/worktree
        // metadata reflects it — instead of a plain repo-root tab the launched command cd's
        // into. Falls back to that plain tab below when there is no resolvable worktree path
        // or the worktree-open attempt itself fails for any reason.
        const worktreeTarget = await resolveHerdrWorktreeTarget(r, input);
        const acquired = worktreeTarget
          ? await acquireHerdrWorktreeTab(repo, r.local_path, worktreeTarget)
          : null;
        if (acquired) {
          tabId = acquired.tabId;
          rootPaneId = acquired.rootPaneId;
          workspaceId = acquired.workspaceId;
          createdWorkspace = acquired.createdWorkspace;
        } else {
          const tabCreate = herdrTabCreateArgv(repo);
          const out = await runHerdr(
            tabCreate[0],
            tabCreate.slice(1),
            r.local_path,
            {
              captureStdout: true,
              timeoutMs: 10_000,
            },
          );
          tabId = parseHerdrTabId(out);
          rootPaneId = parseHerdrRootPaneId(out);
        }
      }
      // Zero exit with no parseable id means a tab (or, when createdWorkspace, a whole workspace)
      // was likely created but can't be closed on failure (no id) — every such launch leaks one
      // empty tab or workspace. Log server-side (never to the client) so a herdr output-format
      // drift is noticed instead of silently leaking them.
      if (!tabId)
        console.error(
          `herdr ${createdWorkspace ? "workspace" : "tab"} create succeeded but its output had no usable tab id; falling back to split placement`,
        );
      else if (createdWorkspace && !workspaceId)
        console.error(
          "herdr workspace create succeeded but its output had no usable workspace id; failure cleanup may be unable to remove it",
        );
    } catch {
      tabId = null;
      rootPaneId = null;
      workspaceId = null;
    }
    // A workspace whose seeded tab id failed to parse can never be targeted — buildHerdrLaunchPlan
    // below only routes the agent into it via --tab — so it would otherwise sit orphaned forever
    // regardless of whether the agent-start call that follows succeeds or fails. Close it now
    // rather than relying on the failure-only cleanup further down. Applies whenever this launch
    // owns a freshly created workspace (workspaceId is only ever set in that case — see the
    // createdWorkspace comment above), not just the issue-create path.
    if (workspaceId && !tabId) {
      const cleanup = herdrWorkspaceCloseArgv(repo, workspaceId);
      runHerdrLaunch(cleanup[0], cleanup.slice(1), r.local_path).catch(
        () => {},
      );
      workspaceId = null;
      rootPaneId = null;
    }

    const plan = buildHerdrLaunchPlan({
      repo,
      command,
      label: input.label,
      tabId,
    });
    // Non-blocking: lh-web is a single process also serving SSE/WebSocket terminals for every
    // client, so a synchronous spawnSync here would stall the whole server for as long as the
    // Herdr launch takes (or hangs).
    try {
      await runHerdrLaunch(plan.argv[0], plan.argv.slice(1), plan.cwd);
    } catch (e) {
      // Don't leave the just-created empty tab (or workspace) behind; fire-and-forget cleanup.
      // herdr refuses to close a workspace's last remaining tab, so whenever a workspace was
      // created, close the whole workspace instead — even if tabId itself failed to parse (the
      // two ids come from independent parses of the same response, see the workspaceId comment
      // above, so either one can be set without the other).
      if (workspaceId) {
        const cleanup = herdrWorkspaceCloseArgv(repo, workspaceId);
        runHerdrLaunch(cleanup[0], cleanup.slice(1), r.local_path).catch(
          () => {},
        );
      } else if (tabId) {
        const cleanup = herdrTabCloseArgv(repo, tabId);
        runHerdrLaunch(cleanup[0], cleanup.slice(1), r.local_path).catch(
          () => {},
        );
      }
      // Attach the actual `herdr ...` invocation (not plan.command, which is only the inner
      // workflow command herdr would run) so the client can re-run the real command locally and
      // see the full output itself — this rides on top of the deliberately generic message (see
      // the comment on runHerdrLaunch above), so the client still never sees raw stdout/stderr/paths.
      //
      // Only suggest creating the session for the non-zero-exit case: that's the one empirically
      // confirmed to happen when the named session doesn't exist yet (`agent start` only works
      // against an already-running session, unlike the auto-creating bare `herdr --session` form).
      // ENOENT (herdr missing from PATH) or a signal-killed process have unrelated causes, and
      // suggesting `herdr --session <name>` there would just fail again the same way, misdirecting
      // the user away from the real fix.
      //
      // The suggested command is built from a tab-less plan: the failed argv's `--tab <id>`
      // points at the tab that was just cleaned up above, so re-running it verbatim would fail
      // with an unknown-tab error instead of reproducing the original failure.
      if (isServiceError(e))
        throw new ServiceError(e.status, e.message, {
          command: herdrCommandLine(
            buildHerdrLaunchPlan({ repo, command, label: input.label }),
          ),
          session: /^Herdr exited with status \d+$/.test(e.message)
            ? plan.sessionName
            : undefined,
        });
      throw e;
    }
    // Switch herdr's active workspace to the one just created, now that the agent is running in
    // it (#556) — the create/open call above used `--no-focus` so creation itself wouldn't yank
    // focus mid-launch, which otherwise left the new workspace selectable only by hand. Scoped to
    // createdWorkspace (not isNewWorkspace): the New Issue path always creates its own workspace,
    // but a worktree-backed launch (#551) does too on a first-time `worktree open` — both cases
    // land the agent in a workspace nobody was looking at yet, so both should get focus. A
    // *reused* worktree workspace (workspaceId null, createdWorkspace false) keeps whatever was
    // already focused, same as before. Fire-and-forget, same as the pane close below: the agent
    // is already running, so a failure to switch selection must not fail the launch.
    if (createdWorkspace && workspaceId) {
      const focus = herdrWorkspaceFocusArgv(repo, workspaceId);
      runHerdrLaunch(focus[0], focus.slice(1), r.local_path).catch(() => {});
    }
    // The agent's own pane now exists alongside the tab's leftover empty root pane (see the
    // rootPaneId comment above) — close it. Fire-and-forget: the agent is already running, so a
    // failure here must not fail the launch, only leave one harmless empty pane behind.
    if (tabId && rootPaneId) {
      const paneClose = herdrPaneCloseArgv(repo, rootPaneId);
      runHerdrLaunch(paneClose[0], paneClose.slice(1), r.local_path).catch(
        () => {},
      );
    }
    return {
      backend,
      session_name: plan.sessionName,
      command: plan.command,
      cwd: plan.cwd,
      attach: `herdr session attach ${plan.sessionName}`,
    };
  },

  // Running herdr sessions grouped by repo, for the sidebar status section (#495).
  // Read-only and deliberately failure-tolerant: herdr missing from PATH, no running
  // sessions, or unparseable output all degrade to an empty list — the sidebar hides
  // the section instead of surfacing an error. Not gated on the configured launch
  // backend: sessions started outside LoopHub are just as real to a supervisor.
  sessions(): Promise<{ repos: HerdrRepoSessions[] }> {
    if (herdrSessionsInflight) return herdrSessionsInflight;
    herdrSessionsInflight = sweepHerdrSessions().finally(() => {
      herdrSessionsInflight = null;
    });
    return herdrSessionsInflight;
  },

  // Recent terminal output for one herdr agent, for the sidebar hover preview (#500).
  // `target` is whatever the client sends as a herdr `agent read` target — usually a
  // pane_id, since herdr only resolves an agent *name* target when it's unique within
  // the session, and two label-less launches can share a display name (the sidebar
  // client prefers pane_id for exactly this reason; see agentReadTarget() in
  // web/src/components/sidebar-herdr-sessions.tsx). Same failure-tolerance as
  // sessions() above: herdr not running, the session gone, or the agent no longer
  // present all degrade to a null output instead of an error, so the client just
  // doesn't show a preview.
  async agentRead(input: {
    repo: string;
    target: string;
    lines?: number;
  }): Promise<{
    output: string | null;
    cols: number | null;
    rows: number | null;
  }> {
    if (!input.target) throw new ServiceError(422, "target is required");
    const lines = clampAgentReadLines(input.lines);
    let sessionName: string;
    try {
      sessionName = herdrSessionName(repoOr404(input.repo));
    } catch {
      return { output: null, cols: null, rows: null };
    }
    // Read and layout run independently: a target that's the display-name fallback (no real
    // pane_id — see NO_PANE_ID_PREFIX) resolves fine for `agent read` but not for `pane
    // layout --pane`, which only accepts a real pane id. That legitimately fails here (#531);
    // the read must still succeed, and the client falls back to its fixed preview size.
    const [output, layout] = await Promise.all([
      runHerdrCapture([
        "--session",
        sessionName,
        "agent",
        "read",
        input.target,
        "--source",
        "recent",
        "--lines",
        String(lines),
      ])
        .then(parseHerdrAgentRead)
        .catch(() => null),
      runHerdrCapture([
        "--session",
        sessionName,
        "pane",
        "layout",
        "--pane",
        input.target,
      ])
        .then(parseHerdrPaneLayout)
        .catch(() => null),
    ]);
    return { output, cols: layout?.cols ?? null, rows: layout?.rows ?? null };
  },

  // Closes the pane an agent is running in — the sidebar kill button (#521). herdr has no
  // direct "kill agent" command; `pane close` against the agent's pane_id is the confirmed
  // equivalent. Unlike sessions() above, failures here must reach the client (silently
  // swallowing a kill the user asked for would be worse than a visible error), so this
  // rejects with runHerdr's ServiceError as-is instead of degrading to a default.
  async killAgent(input: { repo: string; paneId: string }): Promise<{
    ok: true;
  }> {
    if (!input.repo) throw new ServiceError(422, "repo is required");
    if (!input.paneId) throw new ServiceError(422, "paneId is required");
    if (input.paneId.startsWith(NO_PANE_ID_PREFIX))
      throw new ServiceError(
        422,
        "This agent has no pane id available to close",
      );
    // Unlike tab/pane ids parsed from herdr's own stdout (parseHerdrTabId /
    // parseHerdrRootPaneId), paneId here comes straight from an external JSON-RPC caller —
    // reject anything that doesn't look like a real herdr id before it reaches the argv.
    if (!HERDR_ID.test(input.paneId))
      throw new ServiceError(422, "paneId is not a valid herdr pane id");
    const r = repoOr404(input.repo);
    const argv = herdrPaneCloseArgv(r, input.paneId);
    await runHerdr(argv[0], argv.slice(1), r.local_path, {
      timeoutMs: 10_000,
    });
    return { ok: true };
  },
};

const HERDR_AGENT_READ_DEFAULT_LINES = 40;
const HERDR_AGENT_READ_MAX_LINES = 300;

function clampAgentReadLines(lines: number | undefined): number {
  if (!Number.isFinite(lines) || !lines) return HERDR_AGENT_READ_DEFAULT_LINES;
  return Math.min(
    Math.max(Math.trunc(lines as number), 1),
    HERDR_AGENT_READ_MAX_LINES,
  );
}

async function sweepHerdrSessions(): Promise<{ repos: HerdrRepoSessions[] }> {
  let listOut: string;
  try {
    listOut = await runHerdrCapture(["session", "list", "--json"]);
  } catch {
    return { repos: [] };
  }
  const running = parseHerdrSessionList(listOut);
  if (running.length === 0) return { repos: [] };

  const matched = reposWithRunningSession(S.listRepos("active"), running);
  const groups = await Promise.all(
    matched.map(async ({ repo, sessionName }) => {
      let agentsOut: string;
      try {
        // No `--json` here: `herdr agent list` rejects the flag and already prints JSON.
        agentsOut = await runHerdrCapture([
          "--session",
          sessionName,
          "agent",
          "list",
        ]);
      } catch {
        return null;
      }
      const agents = parseHerdrAgentList(agentsOut);
      // A running session with zero agents has nothing to show — drop the group so
      // the sidebar section only appears when there is actual agent activity.
      if (agents.length === 0) return null;
      return { repo: repo.full_name, session_name: sessionName, agents };
    }),
  );
  return { repos: groups.filter((g) => g !== null) };
}

// ===== global settings =====
// Instance-level config.json settings, as opposed to the repo-scoped settings above (#474).
// terminalLaunchBackend is the first field; more can be added to both the input/result shape
// and the validation below as they're introduced.
export const settings = {
  get(): {
    terminalLaunchBackend: TerminalLaunchBackend;
    autoModeOnBuild: boolean;
    codingAgent: CodingAgent;
  } {
    return {
      terminalLaunchBackend: terminalLaunchBackend(),
      autoModeOnBuild: autoModeOnBuild(),
      codingAgent: codingAgent(),
    };
  },

  update(
    input: {
      terminalLaunchBackend?: TerminalLaunchBackend;
      autoModeOnBuild?: boolean;
      codingAgent?: CodingAgent;
    },
    sessionId?: string | null,
  ): {
    terminalLaunchBackend: TerminalLaunchBackend;
    autoModeOnBuild: boolean;
    codingAgent: CodingAgent;
  } {
    if (
      input.terminalLaunchBackend !== undefined &&
      input.terminalLaunchBackend !== "builtin" &&
      input.terminalLaunchBackend !== "herdr"
    ) {
      throw new ServiceError(
        422,
        "terminalLaunchBackend must be one of: builtin, herdr",
      );
    }
    if (
      input.autoModeOnBuild !== undefined &&
      typeof input.autoModeOnBuild !== "boolean"
    ) {
      throw new ServiceError(422, "autoModeOnBuild must be a boolean");
    }
    if (
      input.codingAgent !== undefined &&
      input.codingAgent !== "claude-code" &&
      input.codingAgent !== "codex"
    ) {
      throw new ServiceError(
        422,
        "codingAgent must be one of: claude-code, codex",
      );
    }
    updateConfig(input);
    const actor = actorFor(sessionId);
    S.emitEvent(null, "settings.updated", actor, input);
    return settings.get();
  },
};

// ===== agent sessions =====
export const sessions = {
  register(input: {
    id: string;
    agent: string;
    session: string;
    name?: string | null;
    runtime?: string | null;
    kind?: string | null;
  }) {
    const { id, agent, session, name, runtime, kind } = input;
    if (!id || !agent || !session)
      throw new ServiceError(422, "id, agent, and session are required");
    try {
      // Pass name/runtime/kind straight through (not `?? null`): the store INSERT path applies
      // `?? null` for new rows, while its UPDATE path preserves the existing value when the arg is
      // undefined. Forcing undefined → null here would defeat that preserve-on-re-register contract.
      const { session: row, created } = S.registerAgentSession(
        id,
        agent,
        session,
        name,
        runtime,
        kind,
      );
      S.emitEvent(
        null,
        created ? "agent_session.registered" : "agent_session.updated",
        agent,
        {
          id: row.id,
          agent: row.agent,
          session: row.external_session,
          ...(row.name ? { name: row.name } : {}),
          ...(row.runtime ? { runtime: row.runtime } : {}),
          ...(row.kind ? { kind: row.kind } : {}),
        },
      );
      return { session: agentSessionJSON(row), created };
    } catch (e: any) {
      if (e.message === "CONFLICT_ID" || e.message === "CONFLICT_PAIR") {
        throw new ServiceError(409, "Agent session conflict");
      }
      throw e;
    }
  },

  // Link an already-registered session to an issue or a PR (#298). The generalized attach point for
  // session kinds beyond dev (review, issue-create, …): the launch flows for those kinds live in
  // their own issues, but the base records the link here. Idempotent (the bridge PK is the pair).
  // `target` is { issue } or { pr } — a number resolved against the repo. Emits `agent_session.linked`.
  link(
    name: string,
    input: { sessionId: string; issue?: number; pr?: number },
  ): { session_id: string; issue_number?: number; pr_number?: number } {
    const r = repoOr404(name);
    ensureWritable(r);
    const { sessionId, issue, pr } = input;
    if (!sessionId) throw new ServiceError(422, "sessionId is required");
    if ((issue == null) === (pr == null))
      throw new ServiceError(422, "exactly one of issue or pr is required");
    if (!S.getAgentSession(sessionId))
      throw new ServiceError(404, "Agent session not found");
    const targetKind = issue != null ? "issue" : "pull";
    const number = (issue ?? pr) as number;
    const row = issueOr404(r, number, targetKind);
    S.linkSession(sessionId, row.id);
    // `agent_session.*` namespace (matches register's agent_session.registered/updated) so the
    // web event-key router (web/src/lib/event-keys.ts startsWith "agent_session.") invalidates the
    // agent-sessions queries on a link too.
    S.emitEvent(r.id, "agent_session.linked", actorFor(sessionId), {
      session_id: sessionId,
      [targetKind === "pull" ? "pr" : "issue"]: row.number,
    });
    return {
      session_id: sessionId,
      ...(targetKind === "pull"
        ? { pr_number: row.number }
        : { issue_number: row.number }),
    };
  },

  list() {
    return S.listAgentSessions().map(agentSessionJSON);
  },

  get(id: string) {
    const row = S.getAgentSession(id);
    if (!row) throw new ServiceError(404, "Not Found");
    return agentSessionJSON(row);
  },

  // The related-sessions list for a PR or issue (#298), standalone — same payload pullJSON/issueJSON
  // embed as `related_sessions`, exposed directly for clients that want it without the full detail.
  listFor(name: string, input: { issue?: number; pr?: number }): any[] {
    const r = repoOr404(name);
    const { issue, pr } = input;
    if ((issue == null) === (pr == null))
      throw new ServiceError(422, "exactly one of issue or pr is required");
    if (issue != null)
      return relatedSessionsJSON(issueOr404(r, issue, "issue"));
    const row = issueOr404(r, pr as number, "pull");
    return relatedSessionsJSON(row, {
      primarySessionId: S.primaryDevSessionForPull(row.id),
    });
  },
};

// ===== issues =====
export const issues = {
  async list(
    name: string,
    opts: {
      state?: string;
      kind?: "issue" | "pull" | "any";
      labels?: string[];
      page?: number;
      perPage?: number;
      sort?: "updated" | "created";
    } = {},
  ) {
    const r = repoOr404(name);
    const state = opts.state ?? "open";
    const kind = opts.kind ?? "any";
    const labelsFilter = opts.labels ?? [];
    const perPage = clampPerPage(
      opts.perPage,
      DEFAULT_LIST_PER_PAGE,
      MAX_LIST_PER_PAGE,
    );
    const page = opts.page && opts.page >= 1 ? opts.page : 1;
    let rows = S.listIssues(r.id, kind, state, opts.sort ?? "updated");
    if (labelsFilter.length) {
      rows = rows.filter((row) => {
        const names = S.issueLabels(row.id).map((l: any) => l.name);
        return labelsFilter.every((l) => names.includes(l));
      });
    }
    // Enrich each issue's linked PR with status (working / review / mergeable /
    // diff totals) for the issue-list sub-row. Async git fan-out, bounded by the
    // pagination slice above; other surfaces keep the sync issueJSON summary.
    return Promise.all(
      paginate(rows, perPage, page).map((row) => issueListItemJSON(row, r)),
    );
  },

  // Issue detail. Unlike the list/summary `issueJSON` (where `comments` is just a count),
  // the detail also carries `comment_list` — the full comment bodies (author, time, text) — so
  // an implementation agent reading an issue via `lh issue view --json` gets the design context
  // people leave in comments, not only the body (#231). The summary path stays a count to keep
  // the issue list cheap.
  get(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number);
    const out = issueJSON(row, r);
    out.comment_list = S.listComments(row.id).map(commentJSON);
    // Detail-only (#298): the issue's related sessions, newest first. Resume is offered via the
    // linked PR (relatedSessionJSON marks issue-container rows "resume-via-pull"), not the issue.
    out.related_sessions = relatedSessionsJSON(row);
    return out;
  },

  create(
    name: string,
    input: { title: string; body?: string; labels?: string[] },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    if (!input.title) throw new ServiceError(422, "title is required");
    const actor = actorFor(sessionId);
    const issue = S.createIssue(
      r.id,
      "issue",
      input.title,
      input.body ?? "",
      actor,
    ) as any;
    if (input.labels?.length) S.setLabels(r.id, issue.id, input.labels);
    S.emitEvent(r.id, "issue.opened", actor, { number: issue.number });
    return issueJSON(S.getIssue(r.id, issue.number), r);
  },

  // Plain edits only (title/body/state/labels). Assignment has dedicated procedures.
  update(
    name: string,
    number: number,
    patch: { title?: string; body?: string; state?: string; labels?: string[] },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    if (
      patch.state !== undefined &&
      patch.state !== "open" &&
      patch.state !== "closed"
    ) {
      throw new ServiceError(422, 'state must be "open" or "closed"');
    }
    const actor = actorFor(sessionId);
    const wasOpen = row.state === "open";

    const fields: Record<string, any> = {};
    for (const k of ["title", "body", "state"] as const) {
      if (patch[k] !== undefined) fields[k] = patch[k];
    }
    if (Object.keys(fields).length) S.updateIssue(row.id, fields);
    if (patch.labels !== undefined) {
      S.setLabels(r.id, row.id, patch.labels);
      S.emitEvent(r.id, "issue.labeled", actor, {
        number: row.number,
        labels: patch.labels,
      });
    }
    if (patch.state === "closed" && wasOpen) {
      S.emitEvent(
        r.id,
        row.kind === "pull" ? "pull_request.updated" : "issue.closed",
        actor,
        {
          number: row.number,
        },
      );
    } else if (patch.state === "open" && !wasOpen) {
      S.emitEvent(
        r.id,
        row.kind === "pull" ? "pull_request.updated" : "issue.reopened",
        actor,
        {
          number: row.number,
        },
      );
    }
    if (patch.title !== undefined || patch.body !== undefined) {
      S.emitEvent(
        r.id,
        row.kind === "pull" ? "pull_request.updated" : "issue.updated",
        actor,
        {
          number: row.number,
        },
      );
    }
    return issueJSON(S.getIssue(r.id, row.number), r);
  },

  addLabels(
    name: string,
    number: number,
    names: string[],
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    const actor = actorFor(sessionId);
    S.addLabels(r.id, row.id, names);
    S.emitEvent(r.id, "issue.labeled", actor, {
      number: row.number,
      labels: names,
    });
    return S.issueLabels(row.id).map(labelJSON);
  },

  removeLabel(
    name: string,
    number: number,
    label: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    S.removeLabel(r.id, row.id, label);
    const actor = actorFor(sessionId);
    const labels = S.issueLabels(row.id).map((l: any) => l.name);
    S.emitEvent(r.id, "issue.labeled", actor, { number: row.number, labels });
  },
};

// ===== comments =====
export const comments = {
  list(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number);
    return S.listComments(row.id).map(commentJSON);
  },

  create(
    name: string,
    number: number,
    body: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    if (!body) throw new ServiceError(422, "body is required");
    const actor = actorFor(sessionId);
    const m = S.createComment(row.id, actor, body) as any;
    S.emitEvent(r.id, "issue.commented", actor, {
      number: row.number,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    return commentJSON(m);
  },

  createForPull(
    name: string,
    number: number,
    body: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    if (!body) throw new ServiceError(422, "body is required");
    const actor = actorFor(sessionId);
    const m = S.createComment(row.id, actor, body) as any;
    S.emitEvent(r.id, "issue.commented", actor, {
      number: row.number,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    return commentJSON(m);
  },
};

// ===== labels =====
export const labels = {
  list(name: string) {
    const r = repoOr404(name);
    return S.listLabels(r.id).map(labelJSON);
  },
};

// ===== issue groups (#312) =====
// A bolt-on, repo-scoped grouping of issues to work through in order (data model in db.ts/store.ts).
// Membership is many-to-many with a per-group order; the issues table is never touched. Groups are
// identified to callers by their numeric id (names are mutable and only unique within a repo).
function issueGroupOr404(r: S.Repo, id: number): any {
  const g = S.getIssueGroupById(id);
  if (!g || g.repo_id !== r.id) throw new ServiceError(404, "Not Found");
  return g;
}

// An issue group only collects real issues (kind='issue'), not PRs — PRs are tracked via their
// linked issue. Resolve a member by issue *number* (the caller-facing identifier) like every other
// issue-addressed procedure.
function groupIssueOr404(r: S.Repo, number: number): any {
  return issueOr404(r, number, "issue");
}

export const issueGroups = {
  list(name: string) {
    const r = repoOr404(name);
    return S.listIssueGroups(r.id).map(issueGroupJSON);
  },

  get(name: string, id: number) {
    const r = repoOr404(name);
    return issueGroupJSON(issueGroupOr404(r, id));
  },

  // Ordered issues in a group (by insertion position). Returns full issue objects.
  members(name: string, id: number) {
    const r = repoOr404(name);
    const g = issueGroupOr404(r, id);
    return S.listGroupMembers(g.id).map((row) => issueJSON(row, r));
  },

  // Groups the given issue belongs to, each with its ordered members (#314). Powers the
  // "other issues in the same group" list on the issue detail view. The issue itself is included
  // in each group's `members` (the caller filters it out); membership is many-to-many, so an issue
  // can appear under several groups. Returns [] when the issue belongs to no group.
  forIssue(name: string, number: number) {
    const r = repoOr404(name);
    const issue = groupIssueOr404(r, number);
    return S.listGroupsForIssue(issue.id).map((g) => ({
      group: issueGroupJSON(g),
      members: S.listGroupMembers(g.id).map((row) => issueJSON(row, r)),
    }));
  },

  create(name: string, groupName: string, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const trimmed = (groupName ?? "").trim();
    if (!trimmed) throw new ServiceError(422, "name is required");
    if (S.getIssueGroupByName(r.id, trimmed))
      throw new ServiceError(422, `group already exists: ${trimmed}`);
    const actor = actorFor(sessionId);
    const row = S.createIssueGroup(r.id, trimmed);
    // session identity is carried by `actor` (actorFor resolves the session), matching the
    // pre-existing issue.* events — no separate session_id field in the payload.
    S.emitEvent(r.id, "issue_group.created", actor, {
      group_id: row.id,
      name: trimmed,
    });
    return issueGroupJSON(row);
  },

  rename(
    name: string,
    id: number,
    groupName: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const g = issueGroupOr404(r, id);
    const trimmed = (groupName ?? "").trim();
    if (!trimmed) throw new ServiceError(422, "name is required");
    const clash = S.getIssueGroupByName(r.id, trimmed);
    if (clash && clash.id !== g.id)
      throw new ServiceError(422, `group already exists: ${trimmed}`);
    const actor = actorFor(sessionId);
    const row = S.renameIssueGroup(g.id, trimmed);
    S.emitEvent(r.id, "issue_group.renamed", actor, {
      group_id: g.id,
      name: trimmed,
    });
    return issueGroupJSON(row);
  },

  remove(name: string, id: number, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const g = issueGroupOr404(r, id);
    const actor = actorFor(sessionId);
    S.deleteIssueGroup(g.id);
    S.emitEvent(r.id, "issue_group.deleted", actor, {
      group_id: g.id,
      name: g.name,
    });
    return { deleted: true, id: g.id };
  },

  // Add an issue (by number) to a group; appends to the group's order. Idempotent — re-adding an
  // existing member is a no-op (no event) and returns the unchanged group.
  addIssue(
    name: string,
    id: number,
    issueNumber: number,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const g = issueGroupOr404(r, id);
    const issue = groupIssueOr404(r, issueNumber);
    const actor = actorFor(sessionId);
    if (S.addIssueToGroup(g.id, issue.id)) {
      S.emitEvent(r.id, "issue_group.issue_added", actor, {
        group_id: g.id,
        number: issue.number,
      });
    }
    return issueGroupJSON(S.getIssueGroupById(g.id));
  },

  // Remove an issue (by number) from a group. No-op (no event) if it was not a member.
  removeIssue(
    name: string,
    id: number,
    issueNumber: number,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const g = issueGroupOr404(r, id);
    const issue = groupIssueOr404(r, issueNumber);
    const actor = actorFor(sessionId);
    if (S.removeIssueFromGroup(g.id, issue.id)) {
      S.emitEvent(r.id, "issue_group.issue_removed", actor, {
        group_id: g.id,
        number: issue.number,
      });
    }
    return issueGroupJSON(S.getIssueGroupById(g.id));
  },
};

// ===== review notes (#204, PR-independent since #216) =====
// A review note is a short, fact-based description of one file's diff — what the file is, what
// changed, what to look at — to orient a reviewer. Each note is bound to a diff range
// (base_sha -> commit_sha) within a repo and a concrete file path; that tuple is its identity, so a
// note stands on its own without a PR. A PR may be associated optionally (pass `pr`): the note then
// also belongs to that PR and, if the range is omitted, defaults to the PR's current base/head.
function reviewNoteOr404(r: S.Repo, id: number): any {
  const n = S.getReviewNoteById(id);
  if (!n || n.repo_id !== r.id) throw new ServiceError(404, "Not Found");
  return n;
}

export const reviewNotes = {
  // List a repo's notes (newest first). All filters are optional: `pr` narrows to one PR's notes,
  // path to one file, baseSha/commitSha to one diff range. Filtering by (baseSha, commitSha, path)
  // is how a consumer fetches the notes for a bare commit range with no PR.
  list(
    name: string,
    opts: {
      pr?: number;
      path?: string;
      baseSha?: string;
      commitSha?: string;
    } = {},
  ) {
    const r = repoOr404(name);
    let issueId: number | undefined;
    if (opts.pr !== undefined) {
      issueId = issueOr404(r, opts.pr, "pull").id;
    }
    return S.listReviewNotes(r.id, {
      issueId,
      path: opts.path,
      baseSha: opts.baseSha,
      commitSha: opts.commitSha,
    }).map(reviewNoteJSON);
  },

  get(name: string, id: number) {
    const r = repoOr404(name);
    return reviewNoteJSON(reviewNoteOr404(r, id));
  },

  // Create a note for a file's diff range. Two modes:
  //   - PR-independent: pass baseSha + commitSha (the diff range). No PR is involved.
  //   - PR-associated: pass `pr`; the range defaults to the PR's current base/head when omitted, and
  //     the note links to the PR. An explicit range is still honored (e.g. to annotate a past commit).
  async create(
    name: string,
    input: {
      path: string;
      body: string;
      baseSha?: string;
      commitSha?: string;
      pr?: number;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    if (!input.path) throw new ServiceError(422, "path is required");
    if (!input.body) throw new ServiceError(422, "body is required");
    let issueId: number | null = null;
    let baseSha = input.baseSha ?? null;
    let commitSha = input.commitSha ?? null;
    if (input.pr !== undefined) {
      const pr = issueOr404(r, input.pr, "pull");
      issueId = pr.id;
      // Default the range to the PR's current base/head, resolved to concrete SHAs so the note
      // records the exact range, not a moving ref.
      const p = S.getPull(pr.id);
      baseSha = baseSha ?? (await revParse(r.local_path, p.base_ref)) ?? null;
      commitSha =
        commitSha ?? (await revParse(r.local_path, p.head_ref)) ?? null;
    }
    if (!baseSha || !commitSha)
      throw new ServiceError(
        422,
        "base_sha and commit_sha are required for the diff range (or pass pr to default them)",
      );
    const actor = actorFor(sessionId);
    const row = S.createReviewNote({
      repoId: r.id,
      issueId,
      baseSha,
      commitSha,
      path: input.path,
      body: input.body,
      author: actor,
    });
    const pr = issueId ? S.getIssueById(issueId) : null;
    S.emitEvent(r.id, "pull_request.review_note_created", actor, {
      ...(pr ? { number: pr.number } : {}),
      path: input.path,
      base_sha: baseSha,
      commit_sha: commitSha,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    return reviewNoteJSON(row);
  },

  update(name: string, id: number, body: string, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const n = reviewNoteOr404(r, id);
    if (!body) throw new ServiceError(422, "body is required");
    const actor = actorFor(sessionId);
    const row = S.updateReviewNote(n.id, body);
    const pr = S.getIssueById(n.issue_id);
    S.emitEvent(r.id, "pull_request.review_note_updated", actor, {
      number: pr?.number,
      path: n.path,
    });
    return reviewNoteJSON(row);
  },

  remove(name: string, id: number, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const n = reviewNoteOr404(r, id);
    const actor = actorFor(sessionId);
    S.deleteReviewNote(n.id);
    const pr = S.getIssueById(n.issue_id);
    S.emitEvent(r.id, "pull_request.review_note_deleted", actor, {
      number: pr?.number,
      path: n.path,
    });
    return { deleted: true, id };
  },
};

// ===== pulls =====
function resolveLinkedIssueId(
  r: S.Repo,
  body: string,
  explicit?: number,
): number | null {
  const linkedNumber = explicit ?? parseClosingIssueNumber(body);
  if (linkedNumber == null) return null;
  const row = S.getIssue(r.id, linkedNumber);
  if (!row) throw new ServiceError(422, `issue #${linkedNumber} not found`);
  if (row.kind !== "issue")
    throw new ServiceError(422, `#${linkedNumber} is not an issue`);
  if (S.openPullLinkedToIssue(row.id)) {
    throw new ServiceError(
      422,
      `issue #${linkedNumber} already has an open pull request`,
    );
  }
  return row.id;
}

export const pulls = {
  async list(
    name: string,
    opts: {
      state?: string;
      merged?: "only" | "exclude" | null;
      head?: string;
      base?: string;
      page?: number;
      perPage?: number;
    } = {},
  ) {
    const r = repoOr404(name);
    const state = opts.state ?? "open";
    const perPage = clampPerPage(
      opts.perPage,
      DEFAULT_LIST_PER_PAGE,
      MAX_LIST_PER_PAGE,
    );
    const page = opts.page && opts.page >= 1 ? opts.page : 1;
    let rows = S.listPulls(r.id, state, opts.merged ?? null);
    if (opts.head || opts.base) {
      rows = rows.filter((row) => {
        const p = S.getPull(row.id);
        if (!p) return false;
        if (opts.head && p.head_ref !== opts.head) return false;
        if (opts.base && p.base_ref !== opts.base) return false;
        return true;
      });
    }
    return Promise.all(
      paginate(rows, perPage, page).map((row) => pullJSON(r, row)),
    );
  },

  get(name: string, number: number) {
    const r = repoOr404(name);
    return pullJSON(r, issueOr404(r, number, "pull"), {
      withRelatedSessions: true,
    });
  },

  async create(
    name: string,
    input: {
      title: string;
      body?: string;
      // Either a fixed branch name, or a callback deriving one from the PR's own number once
      // assigned (e.g. dev.openPr's PR-id worktree branch convention, #463) — exactly one is
      // required.
      head?: string;
      headFromNumber?: (prNumber: number) => string;
      base: string;
      issue?: number;
      draft?: boolean;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const { title, body = "", base, issue, draft = false } = input;
    if (!title || (!input.head && !input.headFromNumber) || !base)
      throw new ServiceError(422, "title, head, base are required");
    const actor = actorFor(sessionId);
    // Soft "one open PR per linked issue" guard: refuse a second open PR for an issue that already
    // has one. This is the double-`lh dev` guard (not a DB constraint — see #186 dev.note), so it
    // can be relaxed later to allow multiple proposal PRs per issue.
    const linkedIssueId = resolveLinkedIssueId(r, body, issue);
    const linkedNumber = issue ?? parseClosingIssueNumber(body);
    // Create the issue row first so a PR-number-derived head (headFromNumber) can be computed
    // from its assigned number; a plain string head is unaffected by this reordering. The head
    // branch itself need not exist yet in git — revParse resolves a null sha for a missing ref
    // rather than throwing, which is what lets `lh dev` open the PR before the branch/worktree
    // exist (#463).
    const row = S.createIssue(r.id, "pull", title, body, actor) as any;
    const head = input.head ?? input.headFromNumber!(row.number);
    const headSha = await revParse(r.local_path, head);
    S.createPull(
      row.id,
      head,
      base,
      headSha,
      linkedIssueId,
      sessionId ?? null,
      draft,
    );
    // Carry the draft flag (#413) on the payload so event-driven consumers can tell a WIP PR
    // (`lh dev` opens drafts) from a reviewable one without a follow-up read.
    S.emitEvent(r.id, "pull_request.opened", actor, {
      number: row.number,
      linked_issue: linkedNumber ?? undefined,
      draft,
    });
    return pullJSON(r, S.getIssue(r.id, row.number));
  },

  update(
    name: string,
    number: number,
    patch: { state?: string; title?: string; body?: string },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    if (
      patch.state !== undefined &&
      patch.state !== "open" &&
      patch.state !== "closed"
    ) {
      throw new ServiceError(422, 'state must be "open" or "closed"');
    }
    const p = S.getPull(row.id);
    if (p?.merged && patch.state !== undefined) {
      throw new ServiceError(405, "Pull Request is already merged");
    }
    const actor = actorFor(sessionId);
    S.updateIssue(row.id, patch);
    S.emitEvent(r.id, "pull_request.updated", actor, { number: row.number });
    return pullJSON(r, S.getIssue(r.id, row.number));
  },

  async files(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const p = S.getPull(row.id);
    return diffFiles(r.local_path, p.base_ref, p.head_ref);
  },

  // Whole-file content of a changed file at the PR's base or head commit (#435), for the
  // Markdown preview modal — the diff `files()` above only carries the unified patch. Scoped to
  // paths actually in the PR's diff so this can't be used to read arbitrary tracked files at an
  // arbitrary commit beyond what `files()` already exposes for the same PR.
  async fileAtRef(
    name: string,
    number: number,
    path: string,
    side: "base" | "head",
  ) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const p = S.getPull(row.id);
    if (!(await pathInDiff(r.local_path, p.base_ref, p.head_ref, path))) {
      throw new ServiceError(404, "Not Found");
    }
    const ref = side === "base" ? p.base_ref : p.head_ref;
    return fileAtRef(r.local_path, ref, path);
  },

  // #406: record the GitHub PR a loophub PR was exported to. Originally an internal step of the
  // create-PR-on-GitHub skill; also the general-purpose way to attach a GitHub PR that was created
  // outside LoopHub (e.g. `gh pr create` run directly) back onto its LoopHub PR (#487). Idempotent
  // on the PR — re-recording (including with a different URL/number) overwrites, so a re-run or a
  // correction always reflects the latest link. Validates the URL is an absolute http(s) URL so the
  // UI can render it as a safe link; the GitHub PR number must be a positive integer, and if omitted
  // is derived from the URL's `/pull/<number>` segment (#487).
  recordGithubPull(
    name: string,
    number: number,
    input: { github_number?: number; url: string; branch?: string | null },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const { url, branch } = input;
    // Require an absolute http(s) URL on a GitHub host. The model is GitHub-specific and the UI
    // renders it as a GitHub-branded "View PR on GitHub" link, so accepting an arbitrary host would
    // let a caller plant a misleading link. The scheme check also keeps javascript:/data: out.
    const trimmedUrl = typeof url === "string" ? url.trim() : "";
    if (!/^https?:\/\/\S+$/.test(trimmedUrl) || !isGithubRemoteUrl(trimmedUrl))
      throw new ServiceError(
        422,
        "url must be an absolute GitHub (github.com) http(s) URL",
      );
    const github_number =
      input.github_number ?? parseGithubPullNumber(trimmedUrl);
    if (!Number.isInteger(github_number) || (github_number as number) < 1)
      throw new ServiceError(
        422,
        "github_number must be a positive integer, or derivable from a .../pull/<number> url",
      );
    const actor = actorFor(sessionId);
    const rec = S.recordGithubPull({
      issueId: row.id,
      number: github_number as number,
      url: trimmedUrl,
      branch: branch ?? null,
      createdBy: actor,
    });
    S.emitEvent(r.id, "pull_request.github_pr_recorded", actor, {
      number: row.number,
      github_number,
      url: rec.url,
    });
    return githubPullJSON(rec);
  },

  // #411: orchestrate submitting a loophub PR to GitHub as a Draft PR in one place — push the head
  // branch under a content-based name, open (or recover) a GitHub Draft PR, and record it back.
  // The create-github-pr skill now only generates branch/title/body (LLM work) and calls this,
  // instead of chaining cd → git push → gh pr create → record itself (AGENTS.md: git+DB+destructive
  // orchestration belongs in core). Atomicity: if recording fails after `gh` creates the PR, a
  // re-run finds the existing PR for the branch via `deps.view` and records it rather than opening a
  // duplicate (#406's worst state — created on GitHub but unrecorded). `deps` is an injectable seam
  // (push/gh) so this is unit-testable without a GitHub remote; callers leave it at the default.
  async createGithubPull(
    name: string,
    number: number,
    input: { branch: string; title: string; body: string },
    sessionId?: string | null,
    deps: GithubDeps = realGithubDeps,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");

    // Double-create guard (maintained from record-github-pr): once a GitHub PR is recorded, refuse
    // rather than re-push/re-create. The UI also hides the button, but guard here for non-UI launches.
    const existing = S.getGithubPull(row.id);
    if (existing)
      throw new ServiceError(
        409,
        `PR #${number} already has a GitHub PR (#${existing.number})`,
      );

    const branch = (input.branch ?? "").trim();
    const title = (input.title ?? "").trim();
    const body = input.body ?? "";
    if (!branch) throw new ServiceError(422, "branch is required");
    if (!title) throw new ServiceError(422, "title is required");
    if (!body.trim()) throw new ServiceError(422, "body is required");
    // Strict branch charset: a leading "-" would be parsed by `gh`/`git` as a flag (argument
    // injection — e.g. a branch of `--repo other/repo` could retarget the gh call), and stray
    // characters can break the push refspec. Restrict to a conservative git-ref subset so the value
    // is unambiguous as a positional/flag value downstream.
    if (
      branch.startsWith("-") ||
      branch.includes("..") ||
      !/^[A-Za-z0-9._/-]+$/.test(branch)
    )
      throw new ServiceError(422, "branch contains invalid characters");
    // Don't push the internal branch under its own name (#406: minimal LoopHub traces on GitHub).
    if (/^loophub\//.test(branch))
      throw new ServiceError(
        422,
        "branch must be a content-based name, not the internal loophub/* branch",
      );

    // Require a GitHub origin so push + gh target GitHub.
    if (!isGithubRemoteUrl(await remoteUrl(r.local_path)))
      throw new ServiceError(422, "repo has no GitHub origin remote");

    const p = S.getPull(row.id);
    const base = p.base_ref;
    const head = p.head_ref;
    // Refuse to push onto the base or head branch itself. `git push origin <head>:refs/heads/<branch>`
    // fast-forwards an existing branch (no -f needed when head descends from it), so branch===base
    // would push the head's commits straight onto base and bypass the Draft-PR review flow. head is
    // normally `loophub/*` (already rejected above), but guard explicitly for manual PRs.
    if (branch === base || branch === head)
      throw new ServiceError(
        422,
        "branch must differ from the PR's base and head branches",
      );
    // Run from the main checkout, not the worktree: refs are shared with the worktree, the GitHub
    // origin lives here, and the worktree may have been pruned. This is the location resolution the
    // skill no longer does (its `cd` into the worktree is gone).
    const repoPath = r.local_path;

    try {
      await deps.push(repoPath, head, branch);
    } catch (e) {
      throw new ServiceError(
        502,
        `failed to push branch: ${(e as Error).message}`,
      );
    }

    let gh: { number: number; url: string };
    try {
      // Recover from a prior partial run: reuse an existing PR for the branch instead of opening a
      // duplicate; otherwise create the Draft PR (base follows the loophub PR's base, Draft fixed).
      gh =
        (await deps.view(repoPath, branch)) ??
        (await deps.create(repoPath, { base, head: branch, title, body }));
    } catch (e) {
      throw new ServiceError(
        502,
        `failed to create GitHub PR: ${(e as Error).message}`,
      );
    }

    // Record back into loophub. The URL comes from `gh`, but validate it the same way
    // record-github-pr does so a malformed/unexpected URL never lands in the DB.
    const trimmedUrl = typeof gh.url === "string" ? gh.url.trim() : "";
    if (!/^https?:\/\/\S+$/.test(trimmedUrl) || !isGithubRemoteUrl(trimmedUrl))
      throw new ServiceError(
        502,
        `GitHub returned an unexpected PR URL: ${gh.url}`,
      );
    const actor = actorFor(sessionId);
    const rec = S.recordGithubPull({
      issueId: row.id,
      number: gh.number,
      url: trimmedUrl,
      branch,
      createdBy: actor,
    });
    S.emitEvent(r.id, "pull_request.github_pr_recorded", actor, {
      number: row.number,
      github_number: gh.number,
      url: rec.url,
    });
    return githubPullJSON(rec);
  },

  async merge(
    name: string,
    number: number,
    method: "squash" | "merge" | "rebase",
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const p = S.getPull(row.id);
    if (p.merged) throw new ServiceError(405, "Pull Request is already merged");
    const actor = actorFor(sessionId);
    const message = `${row.title} (#${row.number})`;
    const res = await gitMergePull(
      r.local_path,
      p.base_ref,
      p.head_ref,
      method,
      message,
      actor,
    );
    if (res.conflict) {
      S.emitEvent(r.id, "pull_request.merge_conflict", actor, {
        number: row.number,
      });
      throw new ServiceError(409, "Merge conflict");
    }
    if (!res.merged) throw new ServiceError(422, "Merge failed");
    const closedIssue = S.setMerged(row.id, res.sha!, method);
    S.emitEvent(r.id, "pull_request.merged", actor, {
      number: row.number,
      sha: res.sha,
    });
    if (closedIssue != null) {
      S.emitEvent(r.id, "issue.closed", actor, {
        number: closedIssue,
        closed_by_pull: row.number,
      });
    }
    return { merged: true, sha: res.sha };
  },

  async readyForReview(
    name: string,
    number: number,
    body: string | undefined,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const p = S.getPull(row.id);
    if (p.merged || row.state !== "open")
      throw new ServiceError(422, "Pull Request is not open");
    const actor = actorFor(sessionId);
    // Two distinct "ready for review" transitions share this entry point, both ending in a
    // `pull_request.ready_for_review` event:
    //   (a) draft → ready (#413): a `lh dev` PR opened at the start of work is now done. No prior
    //       review is required — flipping the WIP flag is the whole transition.
    //   (b) re-review after change requests: an already-ready PR whose latest review is
    //       REQUEST_CHANGES is being resubmitted ("I addressed your feedback").
    // Draft takes precedence: a draft PR has no meaningful review history to re-request, so the
    // REQUEST_CHANGES guard below must not block clearing the draft flag.
    if (p.draft) {
      S.setPullDraft(row.id, false);
      const headSha = await revParse(r.local_path, p.head_ref);
      if (headSha) S.setHeadSha(row.id, headSha);
      if (body) S.createComment(row.id, actor, body);
      S.emitEvent(r.id, "pull_request.ready_for_review", actor, {
        number: row.number,
        draft: false,
      });
      return pullJSON(r, S.getIssue(r.id, row.number));
    }
    const latest = S.latestSubstantiveReview(row.id);
    if (latest?.event !== "REQUEST_CHANGES") {
      throw new ServiceError(422, "No pending change requests to address");
    }
    if (p.changes_addressed_at)
      throw new ServiceError(422, "Already marked ready for re-review");
    S.markChangesAddressed(row.id, actor);
    const headSha = await revParse(r.local_path, p.head_ref);
    if (headSha) S.setHeadSha(row.id, headSha);
    if (body) S.createComment(row.id, actor, body);
    S.emitEvent(r.id, "pull_request.ready_for_review", actor, {
      number: row.number,
      draft: false,
    });
    return pullJSON(r, S.getIssue(r.id, row.number));
  },

  // Read-only debug dump: every piece of data a PR can be reached from, gathered into one
  // object so a maintainer can inspect raw DB rows + git facts on a single screen (#248).
  // Intentionally returns near-raw rows (not the trimmed wire serializers) — this is a debug
  // surface, so more fields beat a clean shape. Git lookups degrade to nulls on a missing ref
  // rather than throwing, so the dump still renders for a half-set-up PR.
  async debug(name: string, number: number) {
    const r = repoOr404(name);
    const issueRow = issueOr404(r, number, "pull");
    const pull = S.getPull(issueRow.id);
    const linkedIssue =
      pull.linked_issue_id != null
        ? (S.getIssueById(pull.linked_issue_id) ?? null)
        : null;

    // git facts. Resolve refs first; only fan out to diff/log when both ends exist.
    const headSha = await revParse(r.local_path, pull.head_ref);
    const baseSha = await revParse(r.local_path, pull.base_ref);
    const canDiff = !!headSha && !!baseSha;
    const [stat, commits, files, commitsAheadCount] = canDiff
      ? await Promise.all([
          diffStat(r.local_path, pull.base_ref, pull.head_ref),
          commitLog(r.local_path, pull.base_ref, pull.head_ref),
          diffFiles(r.local_path, pull.base_ref, pull.head_ref),
          commitsAhead(r.local_path, pull.base_ref, pull.head_ref),
        ])
      : [null, [], [], 0];

    const events = S.eventsForPull(
      r.id,
      issueRow.number,
      linkedIssue?.number ?? null,
    ).map((row: any) => formatEvent(row, r.full_name));

    // Serialize the session via agentSessionJSON (not the raw row) so a future secret-bearing
    // column on agent_sessions can't silently flow into the copyable debug dump. The PR's primary
    // dev session is derived from session_links (#316), not a denormalized pulls column.
    const primarySessionId = S.primaryDevSessionForPull(issueRow.id);
    const sessionRow = primarySessionId
      ? (S.getAgentSession(primarySessionId) ?? null)
      : null;

    return {
      repo: repoJSON(r),
      issue_row: issueRow,
      pull_row: pull,
      linked_issue_row: linkedIssue,
      labels: S.issueLabels(issueRow.id),
      git: {
        head_ref: pull.head_ref,
        base_ref: pull.base_ref,
        head_sha: headSha,
        base_sha: baseSha,
        stored_head_sha: pull.head_sha ?? null,
        commits_ahead: commitsAheadCount,
        diffstat: stat,
        commits,
        files,
      },
      reviews: S.listReviews(issueRow.id),
      review_comments: S.listReviewComments(issueRow.id),
      comments: S.listComments(issueRow.id),
      review_notes: S.listReviewNotes(r.id, { issueId: issueRow.id }),
      events,
      session: sessionRow ? agentSessionJSON(sessionRow) : null,
    };
  },
};

// ===== dev (issue-dev loop support) =====
//
// Helpers for the `lh dev` development loop: open a draft PR at the start of work so the
// agent has a place to write its plan and attach decision/action notes, and record those
// notes (`dev.note` events) to the shared events table.

// Allowed `dev.note` kinds. An unknown kind is rejected (422) rather than stored.
export const DEV_NOTE_KINDS = [
  "decision",
  "action",
  "assumption",
  "blocker",
] as const;
export type DevNoteKind = (typeof DEV_NOTE_KINDS)[number];

export const dev = {
  // Open the draft PR for an issue's worktree branch at the start of `lh dev`. Idempotent:
  // if the issue already has an open (unmerged) linked PR, return it untouched. The PR can
  // be opened with 0 commits — LoopHub does not require head to be ahead of base (the diff
  // is just empty until the agent commits). The body seeds a plan placeholder the agent
  // overwrites; `Closes #<n>` links it both ways. `lh dev` calls this *before* provisioning the
  // worktree (#463) so the PR number is known first; head defaults to the PR-id branch
  // convention (worktreeBranch), derived from the PR's own number once assigned — pass an
  // explicit `head` only to override it (e.g. tests simulating a specific branch).
  //
  // `opts.attributeSession` (default true) gates re-pointing an *existing, reused* PR's session
  // pointer (setPullSession) at `sessionId`. `lh dev` needs the PR number before it can claim its
  // (PR-keyed, #463) dev lock, so it calls this before the lock exists — pass `false` there to
  // defer the write until after the lock is won, so a losing concurrent `lh dev` racing on the
  // same already-open PR can never overwrite the winner's session pointer. A brand-new PR
  // (created below) is unaffected by this flag: two racing creates for the same issue make two
  // distinct PR rows, each correctly attributed to its own creating session.
  async openPr(
    name: string,
    input: { issue: number; head?: string; base: string; body?: string },
    sessionId?: string | null,
    opts: { attributeSession?: boolean } = {},
  ): Promise<{ created: boolean; number: number }> {
    const attributeSession = opts.attributeSession ?? true;
    const r = repoOr404(name);
    ensureWritable(r);
    const issueRow = issueOr404(r, input.issue, "issue");
    const existing = S.openPullLinkedToIssue(issueRow.id);
    if (existing) {
      // Re-running `lh dev <issue>` reuses the open PR but must re-point it at the session it is
      // about to spawn (latest-writer-wins), so `lh resume`/retro resolve the current session rather
      // than a stale one. (The old model re-assigned the issue on every run.)
      if (sessionId && attributeSession) {
        S.setPullSession(existing.id, sessionId);
        // setPullSession also appends the session to session_links (#298) — the PR's related-sessions
        // list and the prior session's now-"superseded" verdict change here. Emit a PR-scoped event so
        // the open detail refreshes (the create path below gets this via pull_request.opened).
        S.emitEvent(r.id, "pull_request.updated", actorFor(sessionId), {
          number: existing.number,
        });
      }
      return { created: false, number: existing.number };
    }
    const body = input.body ?? defaultDraftPrBody(input.issue);
    // `lh dev` opens the PR at the *start* of work, so it begins as a draft (#413); the agent
    // flips it to ready via `lh pr ready-for-review` once the implementation is done.
    const pr = await pulls.create(
      name,
      {
        title: issueRow.title,
        body,
        head: input.head,
        headFromNumber: input.head ? undefined : worktreeBranch,
        base: input.base,
        issue: input.issue,
        draft: true,
      },
      sessionId,
    );
    return { created: true, number: pr.number };
  },

  // Attribute a dev session to an existing PR (via session_links, #316) so `lh resume`/retro can
  // later find it. Used by `lh dev <pr>` (the direct-PR path that does not open a new PR) and, as
  // of #463, also by `lh dev <issue>` to attribute the session to a *reused* open PR — deferred
  // here until after the caller's PR-keyed dev lock is won (see dev.openPr's `attributeSession`
  // option), so a losing concurrent launch can never overwrite the winner's pointer. Emits the
  // same `pull_request.updated` event openPr's reuse branch does, so the PR detail's related-
  // sessions list (SSE-driven) refreshes here too. Latest linked dev session wins.
  attachSession(
    name: string,
    number: number,
    sessionId: string,
  ): { number: number } {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    if (sessionId) {
      S.setPullSession(row.id, sessionId);
      S.emitEvent(r.id, "pull_request.updated", actorFor(sessionId), {
        number: row.number,
      });
    }
    return { number: row.number };
  },

  // Record a development note (decision / action / assumption / blocker) as a `dev.note`
  // event in the shared events table. The note targets an issue and/or a PR; the missing
  // side is resolved when possible (a PR's linked issue, or an issue's open linked PR).
  note(
    name: string,
    input: {
      kind: string;
      summary: string;
      body?: string;
      issue?: number;
      pr?: number;
    },
    sessionId?: string | null,
  ): {
    issue_number: number;
    pr_number?: number;
    kind: DevNoteKind;
    summary: string;
    body?: string;
  } {
    const r = repoOr404(name);
    ensureWritable(r);
    const summary = (input.summary ?? "").trim();
    if (!summary) throw new ServiceError(422, "summary is required");
    if (!DEV_NOTE_KINDS.includes(input.kind as DevNoteKind)) {
      throw new ServiceError(
        422,
        `invalid kind "${input.kind}" (expected one of: ${DEV_NOTE_KINDS.join(", ")})`,
      );
    }
    if (input.issue == null && input.pr == null) {
      throw new ServiceError(422, "one of issue or pr is required");
    }
    const kind = input.kind as DevNoteKind;

    let prNumber: number | undefined;
    let issueNumber: number | undefined;
    let prLinkedIssue: number | undefined;
    if (input.pr != null) {
      const prRow = issueOr404(r, input.pr, "pull");
      prNumber = prRow.number;
      const linkedId = S.getPull(prRow.id)?.linked_issue_id;
      if (linkedId != null) {
        prLinkedIssue = S.getIssueById(linkedId)?.number;
        issueNumber = prLinkedIssue;
      }
    }
    if (input.issue != null) {
      const issueRow = issueOr404(r, input.issue, "issue");
      // Both given: reject a PR whose linked issue contradicts the supplied issue,
      // rather than silently recording a mismatched note.
      if (
        input.pr != null &&
        prLinkedIssue != null &&
        prLinkedIssue !== issueRow.number
      ) {
        throw new ServiceError(
          422,
          `issue #${issueRow.number} is not linked to PR #${input.pr}`,
        );
      }
      issueNumber = issueRow.number;
      if (prNumber == null) {
        const open = S.openPullLinkedToIssue(issueRow.id);
        if (open) prNumber = open.number;
      }
    }
    if (issueNumber == null) {
      throw new ServiceError(422, "could not resolve target issue");
    }

    const actor = actorFor(sessionId);
    const body = input.body?.trim() || undefined;
    const payload: {
      issue_number: number;
      pr_number?: number;
      kind: DevNoteKind;
      summary: string;
      body?: string;
    } = { issue_number: issueNumber, kind, summary };
    if (prNumber != null) payload.pr_number = prNumber;
    if (body) payload.body = body;
    S.emitEvent(r.id, "dev.note", actor, payload);
    return payload;
  },
};

// ===== handoffs (#352) =====
//
// The orchestrator<->subagent handoff bus, made durable (lh-build-design.ja.md §6.5). A handoff is
// one explicit document — a parent's instruction (direction="down") or a child's return ("up") —
// recorded out of the volatile conversation so a run's trajectory can be replayed and evaluated.
// Generic by design: any orchestration records through this same procedure (lh-build is the first
// real user); no lh-build-specific field is required.
//
// Linkage: a handoff binds to a PR (`pr`) and/or a generic issue (`issue`) — at least one — plus
// the recording session (the attribution sessionId), so it naturally hangs off "PR + session". The
// body is HYBRID: pass `body` for content with no other home (the instruction prompt, the Verify
// report), or `src` to reference a canonical copy living elsewhere (plan=PR, diff=commit) without
// duplicating it. Exactly one of (body, src) carries the substance. When inline, `hash` defaults to
// the sha256 of `body` for integrity; with `src` the caller supplies `hash` (the referenced
// content's hash). Security: rows persist unencrypted and are never GC'd, so — like dev.note — the
// caller must keep secrets out (this layer validates shape, not secrecy). The body may also carry
// issue-derived (untrusted) text, and `lh handoff list` reads it back into an orchestrator's
// context: consumers MUST treat a recorded body as DATA, never as instructions to act on. The
// broadcast `handoff.recorded` event therefore carries only metadata (seq/phase/direction), never
// the body, so untrusted content is not replayed widely over SSE.
export const HANDOFF_DIRECTIONS = ["down", "up"] as const;
export type HandoffDirection = (typeof HANDOFF_DIRECTIONS)[number];

export const handoffs = {
  record(
    name: string,
    input: {
      phase: string;
      direction: string;
      pr?: number;
      issue?: number;
      from?: string;
      to?: string;
      body?: string;
      src?: string;
      hash?: string;
      summary?: string;
      model?: string;
      cost?: string;
    },
    sessionId?: string | null,
  ): any {
    const r = repoOr404(name);
    ensureWritable(r);

    const phase = (input.phase ?? "").trim();
    if (!phase) throw new ServiceError(422, "phase is required");
    if (!HANDOFF_DIRECTIONS.includes(input.direction as HandoffDirection)) {
      throw new ServiceError(
        422,
        `invalid direction "${input.direction}" (expected one of: ${HANDOFF_DIRECTIONS.join(", ")})`,
      );
    }
    const direction = input.direction as HandoffDirection;

    // Body XOR src: exactly one carries the substance. An empty/whitespace value counts as absent.
    const body = input.body?.trim() ? input.body : undefined;
    const src = input.src?.trim() || undefined;
    if (!body && !src) {
      throw new ServiceError(422, "one of body or src is required");
    }
    if (body && src) {
      throw new ServiceError(
        422,
        "pass only one of body or src (inline content vs a reference)",
      );
    }

    if (input.pr == null && input.issue == null) {
      throw new ServiceError(422, "one of pr or issue is required");
    }
    let prId: number | undefined;
    let prNumber: number | undefined;
    if (input.pr != null) {
      const prRow = issueOr404(r, input.pr, "pull");
      prId = prRow.id;
      prNumber = prRow.number;
    }
    let issueId: number | undefined;
    let issueNumber: number | undefined;
    if (input.issue != null) {
      const issueRow = issueOr404(r, input.issue, "issue");
      issueId = issueRow.id;
      issueNumber = issueRow.number;
    }

    // Link the recording session only when it is registered: handoffs.session_id has an FK to
    // agent_sessions (foreign_keys is ON), so an unregistered attribution id would abort the
    // insert. The actor line still uses sessionId regardless (authorFromSession tolerates absence).
    const sessionLink =
      sessionId && S.getAgentSession(sessionId) ? sessionId : null;

    // Content hash: an explicit --hash wins (the referenced canonical's hash); otherwise, for an
    // inline body, default to its sha256 so the record is self-verifying. A pure reference with no
    // supplied hash stays null.
    const hash =
      input.hash?.trim() ||
      (body ? createHash("sha256").update(body).digest("hex") : undefined);

    const row = S.createHandoff({
      repoId: r.id,
      prId,
      issueId,
      sessionId: sessionLink,
      phase,
      direction,
      fromRole: input.from?.trim() || undefined,
      toRole: input.to?.trim() || undefined,
      body,
      src,
      hash,
      summary: input.summary?.trim() || undefined,
      model: input.model?.trim() || undefined,
      cost: input.cost?.trim() || undefined,
    });

    // Emit a PR-scoped event so the PR detail's handoff section refetches over SSE. payload.number
    // is the PR number (the routing key event-keys.ts maps to the pull detail); pr_number mirrors
    // dev.note for consumers that read it. For an issue-only handoff there is no PR to scope to.
    S.emitEvent(r.id, "handoff.recorded", actorFor(sessionId), {
      ...(prNumber != null ? { number: prNumber, pr_number: prNumber } : {}),
      ...(issueNumber != null ? { issue_number: issueNumber } : {}),
      id: row.id,
      seq: row.seq,
      phase,
      direction,
    });
    return handoffJSON(row);
  },

  list(
    name: string,
    opts: { pr?: number; issue?: number; session?: string } = {},
  ): any[] {
    const r = repoOr404(name);
    const filter: { prId?: number; issueId?: number; sessionId?: string } = {};
    if (opts.pr != null) {
      filter.prId = issueOr404(r, opts.pr, "pull").id;
    }
    if (opts.issue != null) {
      filter.issueId = issueOr404(r, opts.issue, "issue").id;
    }
    if (opts.session != null) {
      filter.sessionId = opts.session;
    }
    return S.listHandoffs(r.id, filter).map(handoffJSON);
  },
};

function defaultDraftPrBody(issue: number): string {
  return [
    "## 実装計画",
    "",
    "<!-- 着手時に実装計画をここへ記入してください -->",
    "",
    `Closes #${issue}`,
    "",
  ].join("\n");
}

// ===== resume (re-enter a PR's dev session) =====
//
// Resolve everything `lh resume <PR id>` needs to relaunch the Claude session that was used to
// develop a PR: the stored Claude session id and the worktree/branch to run it in. State
// resolution (DB + git) lives here; the restorability judgment is the pure decideResume. The CLI
// performs the actual worktree provisioning (provisionWorktree) and `claude --resume` spawn.
export interface ResumeOk {
  ok: true;
  pr: number;
  worktreeScheme: "pr" | "legacy-issue"; // naming convention for the worktree path/branch (#463)
  worktreeNumber: number; // PR number ("pr" scheme) or issue number ("legacy-issue" scheme)
  branch: string; // PR head ref to check out
  runtime: string; // session runtime that selects the resume command (e.g. "claude-code")
  sessionId: string; // runtime session id for the resume command (e.g. `claude --resume <id>`)
  restore: boolean; // true => worktree was removed; re-attach it from the branch
}
export interface ResumeFail {
  ok: false;
  pr: number;
  reason: "no-session" | "unrestorable" | "unknown-runtime";
  branch: string; // PR head ref (named in the "unrestorable" message)
  runtime?: string | null; // the unsupported runtime, when reason is "unknown-runtime"
}
export type ResumeResolution = ResumeOk | ResumeFail;

// Resolve a resume by *session id* rather than by PR (#299). An issue-create session has no PR and
// no dev worktree — it is just a Claude session that filed an issue — so `lh resume --session <id>`
// re-enters it with `claude --resume <id>` in the repo root, bypassing the worktree machinery that
// `resume.resolve` (PR path) needs. Only the runtime check applies: a non-resumable runtime or a
// missing/non-UUID id is reported so the CLI can explain it.
export type SessionResumeResolution =
  | { ok: true; runtime: string; sessionId: string }
  | { ok: false; reason: "not-found" | "no-session" | "unknown-runtime" };

export const resume = {
  async resolve(name: string, prNumber: number): Promise<ResumeResolution> {
    const r = repoOr404(name);
    const prRow = issueOr404(r, prNumber, "pull");
    const pull = S.getPull(prRow.id);
    const headRef: string = pull.head_ref;

    // The PR's resume anchor is the latest kind='dev' session linked to it in session_links (#316),
    // recorded when `lh dev` opened the PR (the `lh dev <issue>` flow) or re-entered it directly
    // (`lh dev <pr>`). #186 removed the old issue-assignee fallback — the PR is the single source of
    // truth; #316 derives it from session_links instead of a denormalized pulls.session_id column.
    const sessionRowId: string | null = S.primaryDevSessionForPull(prRow.id);
    const sessionRow = sessionRowId ? S.getAgentSession(sessionRowId) : null;
    // The session's runtime selects how to resume it. Prefer the explicit runtime column; fall back
    // to "lh-dev agent + no runtime → claude-code" for sessions registered before the column
    // existed (sessionRuntime). resolveRuntimeResume then validates the stored id for that runtime —
    // claude-code needs a UUID for `claude --resume <id>` (guards argv injection); a runtime this
    // build cannot resume (e.g. a future codex session) is reported as unknown-runtime so the CLI
    // can explain it rather than mislabel it "no session".
    const runtime = sessionRuntime(sessionRow);
    const runtimeResume = resolveRuntimeResume(
      runtime,
      sessionRow?.external_session ?? null,
    );
    if (!runtimeResume.ok && runtimeResume.reason === "unknown-runtime") {
      return {
        ok: false,
        pr: prNumber,
        reason: "unknown-runtime",
        branch: headRef,
        runtime,
      };
    }
    const claudeSessionId: string | null = runtimeResume.ok
      ? runtimeResume.sessionId
      : null;

    const identity = resolveWorktreeIdentity(headRef, prNumber);
    const path =
      identity.scheme === "legacy-issue"
        ? legacyWorktreePath(worktreeRoot(), r.full_name, identity.number)
        : worktreePath(worktreeRoot(), r.full_name, identity.number);
    const worktrees = await worktreeList(r.local_path);
    const worktreeExists = worktrees.some(
      (w) => canonicalPath(w.path) === canonicalPath(path),
    );
    const branchPresent = await branchExists(r.local_path, headRef);

    const decision = decideResume({
      sessionId: claudeSessionId,
      worktreeExists,
      branchExists: branchPresent,
    });
    if (!decision.ok) {
      return {
        ok: false,
        pr: prNumber,
        reason: decision.reason,
        branch: headRef,
      };
    }
    return {
      ok: true,
      pr: prNumber,
      worktreeScheme: identity.scheme,
      worktreeNumber: identity.number,
      branch: headRef,
      // decision.ok ⇒ claudeSessionId is non-null ⇒ runtimeResume.ok, so its runtime is set.
      runtime: runtimeResume.ok ? runtimeResume.runtime : RUNTIME_CLAUDE_CODE,
      sessionId: claudeSessionId as string,
      restore: decision.restore,
    };
  },

  // Resolve a session-id resume (#299). Used by `lh resume --session <id>` for sessions that are not
  // a PR's dev session — chiefly the `issue-create` session a New Issue flow records (`lh issue
  // new`). No worktree/branch facts are needed: a resumable Claude session re-enters with
  // `claude --resume <external_session>` in the repo root, so this returns just the runtime + id.
  resolveSession(sessionId: string): SessionResumeResolution {
    const row = S.getAgentSession(sessionId);
    if (!row) return { ok: false, reason: "not-found" };
    const runtimeResume = resolveRuntimeResume(
      sessionRuntime(row),
      row.external_session ?? null,
    );
    if (!runtimeResume.ok) return { ok: false, reason: runtimeResume.reason };
    return {
      ok: true,
      runtime: runtimeResume.runtime,
      sessionId: runtimeResume.sessionId,
    };
  },
};

// ===== reviews =====
export const reviews = {
  list(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return S.listReviews(row.id).map(reviewJSON);
  },

  listComments(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return S.listReviewComments(row.id).map(reviewCommentJSON);
  },

  create(
    name: string,
    number: number,
    input: {
      event?: string;
      body?: string;
      topic?: string;
      comments?: { path: string; line?: number; side?: string; body: string }[];
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    let event = (input.event ?? "COMMENT").toUpperCase();
    // Back-compat: pre-#428 callers still pass "approve" (the old vocabulary).
    if (event === "APPROVE") event = "PASS";
    // Aspect/topic of the review (e.g. design/bug/style/security), so a single
    // commit can carry several reviews distinguished by topic (#209). Free-form;
    // a blank topic is stored as NULL (untagged).
    const topic = input.topic?.trim() || null;
    const lineComments = Array.isArray(input.comments) ? input.comments : [];
    for (const cm of lineComments) {
      if (!cm?.path || !cm?.body)
        throw new ServiceError(422, "each comment requires path and body");
    }
    const actor = actorFor(sessionId);
    // Bind the review to the head it was made against so a PASS can be
    // marked stale once the branch advances past this commit.
    const headSha = S.getPull(row.id)?.head_sha ?? null;
    const v = S.createReview(
      row.id,
      actor,
      event,
      input.body ?? "",
      headSha,
      topic,
    ) as any;
    for (const cm of lineComments) {
      S.createReviewComment(row.id, v.id, actor, {
        path: cm.path,
        line: cm.line,
        side: cm.side,
        body: cm.body,
      });
    }
    if (event === "PASS" || event === "REQUEST_CHANGES")
      S.clearChangesAddressed(row.id);
    S.emitEvent(r.id, "pull_request.review_submitted", actor, {
      number: row.number,
      state: event,
      topic,
      comments: lineComments.length,
    });
    return { ...reviewJSON(v), comments: lineComments.length };
  },
};

// ===== retros (loop retrospectives) =====
//
// Persist a generated retro (rubric scores + free-form findings) for a PR and emit
// `session.retro.created` (loop-retrospective-design.ja.md §4). The skill (`/lh-retro`)
// gathers LoopHub data and produces the rubric/findings; this procedure validates the
// shapes, resolves the PR -> linked issue -> implementation session chain, writes the
// row, and emits the event. Keeping the orchestration here (CLI stays thin) follows the
// core/cli responsibility split.

export const DEFAULT_RETRO_BACKLOG_LIMIT = 20;
export const MAX_RETRO_BACKLOG_LIMIT = 100;

export const retros = {
  create(
    name: string,
    input: {
      pr: number;
      rubric: unknown;
      findings: unknown;
      status?: string;
      redacted?: boolean;
      redact_ruleset?: string | null;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const prRow = issueOr404(r, input.pr, "pull");

    let rubric: ReturnType<typeof validateRubric>;
    let findings: ReturnType<typeof validateFindings>;
    try {
      rubric = validateRubric(input.rubric);
      findings = validateFindings(input.findings);
    } catch (e) {
      if (e instanceof RetroValidationError)
        throw new ServiceError(422, e.message);
      throw e;
    }

    const status = input.status ?? "draft";
    if (!isRetroStatus(status)) {
      throw new ServiceError(
        422,
        `invalid status "${status}" (expected draft|reviewed|applied|dismissed)`,
      );
    }

    // PR -> implementation session (design §4.3.1). The session is the PR's latest kind='dev' link
    // in session_links (primaryDevSessionForPull, #316); issue_id still records the linked issue for
    // the retro. Any link may be absent: a PR with no session/link keeps those NULL and the retro
    // still stands on event/PR data alone.
    const pull = S.getPull(prRow.id);
    const issueId: number | null = pull?.linked_issue_id ?? null;
    const linkedIssue = issueId != null ? S.getIssueById(issueId) : null;
    const implSession: string | null = S.primaryDevSessionForPull(prRow.id);

    const actor = actorFor(sessionId);
    const row = S.createRetro({
      repoId: r.id,
      issueId,
      prId: prRow.id,
      sessionId: implSession,
      rubricJson: JSON.stringify(rubric),
      findingsJson: JSON.stringify(findings),
      status,
      redacted: input.redacted,
      redactRuleset: input.redact_ruleset ?? null,
    }) as any;

    const payload: {
      retro_id: number;
      pr_number: number;
      issue_number?: number;
      session_id?: string;
      status: string;
    } = { retro_id: row.id, pr_number: prRow.number, status };
    if (linkedIssue?.number != null) payload.issue_number = linkedIssue.number;
    if (implSession) payload.session_id = implSession;
    S.emitEvent(r.id, "session.retro.created", actor, payload);

    return retroJSON(row);
  },

  list(name: string, opts: { pr?: number; status?: string } = {}) {
    const r = repoOr404(name);
    let prId: number | null = null;
    if (opts.pr != null) {
      prId = issueOr404(r, opts.pr, "pull").id;
    }
    if (opts.status !== undefined && !isRetroStatus(opts.status)) {
      throw new ServiceError(
        422,
        `invalid status "${opts.status}" (expected draft|reviewed|applied|dismissed)`,
      );
    }
    return S.listRetros(r.id, { prId, status: opts.status }).map(retroJSON);
  },

  get(name: string, id: number) {
    const r = repoOr404(name);
    const row = S.getRetroById(id);
    if (!row || row.repo_id !== r.id) throw new ServiceError(404, "Not Found");
    return retroJSON(row);
  },

  // Backfill helper: merged PRs in the repo with no retro yet (design §5.1).
  pending(name: string, opts: { limit?: number } = {}) {
    const r = repoOr404(name);
    let limit = Number(opts.limit ?? DEFAULT_RETRO_BACKLOG_LIMIT);
    if (!Number.isFinite(limit) || limit < 1)
      limit = DEFAULT_RETRO_BACKLOG_LIMIT;
    limit = Math.min(limit, MAX_RETRO_BACKLOG_LIMIT);
    return S.mergedPullsWithoutRetro(r.id, limit).map((row: any) => ({
      number: row.number,
      title: row.title,
      merged_at: row.merged_at ?? null,
    }));
  },
};

// ===== events =====
export const events = {
  list(
    opts: {
      since?: number;
      repo?: string | null;
      labels?: string[];
      order?: "asc" | "desc";
      limit?: number;
    } = {},
  ): LoopEvent[] {
    const since = Number(opts.since ?? 0);
    const limit = clampPerPage(
      opts.limit,
      MAX_EVENTS_PER_PAGE,
      MAX_EVENTS_PER_PAGE,
    );
    const labels = opts.labels ?? [];
    const order = opts.order === "desc" ? "desc" : "asc";
    let repoId: number | null = null;
    if (opts.repo) {
      const [o, n] = opts.repo.split("/");
      const r = S.getRepo(o, n);
      if (!r) return []; // unknown repo filter -> empty
      repoId = r.id;
    }
    const rows = S.listEvents(since, repoId, limit, labels, order);
    return rows.map((row: any) => {
      const repo =
        opts.repo ??
        (row.repo_id != null
          ? S.getRepoById(row.repo_id)?.full_name
          : undefined);
      return formatEvent(row, repo);
    });
  },

  // Live tail: subscribe to the web server's SSE feed (replay-then-subscribe) and invoke
  // `onEvent` for each matching event until `signal` aborts. Unlike `list`, this needs the
  // resident lh-web process (HTTP); see core/events-follow.ts.
  follow(
    opts: FollowOptions,
    onEvent: (event: LoopEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return followEvents(opts, onEvent, signal);
  },
};

// ===== dashboard =====
// Cross-repo overview for the web top page: the most recently created open
// issues (newest first) and pull requests that are open and not yet merged.
// Each item carries its repo identity so the aggregated view can show which
// project it belongs to.
type RepoRef = { full_name: string; owner: string; name: string };

function repoRef(r: S.Repo): RepoRef {
  return { full_name: r.full_name, owner: r.owner, name: r.name };
}

function byCreatedDesc(
  a: { created_at: string },
  b: { created_at: string },
): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

// Cap for the cross-repo "recently created open issues" list. Bounds the git
// fan-out from enriching each issue's linked PR (issueListItemJSON below):
// serialization runs only after the slice, and only issues that actually have a
// linked PR spawn git — most have none — so this stays well under the per-issue
// worst case even at a higher cap than the open-PR section.
export const DASHBOARD_RECENT_ISSUES_LIMIT = 100;

export const dashboard = {
  async overview() {
    const issueRows: { repo: S.Repo; ref: RepoRef; row: any }[] = [];
    for (const r of S.listRepos("active")) {
      const ref = repoRef(r);
      for (const row of S.listIssues(r.id, "issue", "open")) {
        issueRows.push({ repo: r, ref, row });
      }
    }
    // Cap the section before serialization so the list stays bounded and the
    // git fan-out (issueListItemJSON's linked-PR enrichment) stays bounded.
    // Issues are ordered newest-created first.
    issueRows.sort((a, b) => byCreatedDesc(a.row, b.row));
    // Enrich each issue's linked PR (status word + diff totals + the full
    // linked_pull_requests[] stack) so the home "Recent issues" rows match the
    // dedicated issue list's Pattern E sub-rows. issueListItemJSON is async per
    // the bounded git fan-out, hence Promise.all.
    const issues = await Promise.all(
      issueRows
        .slice(0, DASHBOARD_RECENT_ISSUES_LIMIT)
        .map(async ({ repo, ref, row }) => ({
          repo: ref,
          issue: await issueListItemJSON(row, repo),
        })),
    );
    // Surface the issue cap so the UI can note "showing the N most recent"
    // without duplicating the magic number client-side.
    return { issues, recentIssuesLimit: DASHBOARD_RECENT_ISSUES_LIMIT };
  },
};

// ===== sync =====
export const sync = {
  async run() {
    const emitted = await sweepPullUpdates();
    return {
      updated: emitted.length,
      events: emitted.map((e: any) => ({ id: e.id, type: e.type })),
    };
  },
};

// ===== worktree housekeeping =====
// Batch GC of stale `lh dev` worktrees: the current `loophub/pr-<n>` convention (#463) and the
// legacy pre-#463 `loophub/issue-<n>` convention (still recognized so a worktree provisioned
// before the migration is not orphaned). The orchestration — scanning git worktrees, resolving
// each one's issue/PR state, and the destructive removal — lives here so the CLI stays a thin
// presenter and the logic is unit-testable. Pure decisioning (clean-tree guard, keep/remove/skip
// classification) stays in worktree-prune.ts.

// The number encoded in a LoopHub-managed branch, current or legacy convention — used purely as
// a lookup key into `issues` (which numbers issues and pulls in one sequence per repo), so it does
// not matter here whether it names an issue or a PR row.
function worktreeNumberFromBranch(branch: string | null): number | null {
  return issueNumberFromBranch(branch) ?? prNumberFromBranch(branch);
}

export interface WorktreePlanEntry {
  repo: string; // owner/name
  repoPath: string; // primary checkout (shared .git)
  path: string; // worktree directory
  branch: string;
  issue: number; // the number encoded in the branch (issue or PR, whichever convention applies)
  action: "remove" | "keep" | "skip";
  reason: string;
}

export const worktrees = {
  // Scan LoopHub worktrees across one repo (`repo`) or every registered repo, resolve each
  // worktree's issue/PR state from the DB, and classify. `cwd` is the caller's working dir (the
  // running checkout is never a removal candidate); it is canonicalized here so callers can pass
  // a raw `process.cwd()`.
  async plan(opts: {
    repo?: string | null;
    cwd: string;
  }): Promise<WorktreePlanEntry[]> {
    const repoRows = opts.repo ? [repoOr404(opts.repo)] : S.listRepos("all");
    const cwd = canonicalPath(opts.cwd);
    const entries: WorktreePlanEntry[] = [];
    for (const r of repoRows) {
      for (const wt of await worktreeList(r.local_path)) {
        const n = worktreeNumberFromBranch(wt.branch);
        if (n == null) continue; // primary checkout / off-convention worktrees are not ours

        let issueState: "open" | "closed" | null = null;
        let prMerged = false;
        let prState: "open" | "closed" | null = null;
        // Done-ness comes from the row's own state. A legacy worktree's branch names its issue
        // (row.kind === "issue"), so merged-ness comes from its linked PR; the current #463
        // convention names the worktree after the PR itself (row.kind === "pull"), so its own
        // merged/state apply directly.
        const row = S.getIssue(r.id, n);
        if (row) {
          issueState = row.state;
          if (row.kind === "issue") {
            const pr = S.linkedPullForIssue(row.id);
            if (pr) {
              prMerged = !!pr.merged;
              prState = pr.state;
            }
          } else {
            const pull = S.getPull(row.id);
            prMerged = !!pull?.merged;
            prState = row.state;
          }
        }

        const st = await worktreeStatus(wt.path);
        const dirty = st.code !== 0 || porcelainIsDirty(st.stdout);
        const { action, reason } = classifyWorktree({
          isCwd: canonicalPath(wt.path) === cwd,
          dirty,
          issueState,
          prMerged,
          prState,
        });
        entries.push({
          repo: r.full_name,
          repoPath: r.local_path,
          path: wt.path,
          branch: wt.branch ?? "",
          issue: n,
          action,
          reason,
        });
      }
    }
    return entries;
  },

  // Remove one worktree after re-asserting the safety invariants right before the destructive
  // call: it must still be a registered worktree on its `loophub/pr-<n>` (or legacy
  // `loophub/issue-<n>`) branch (state may have changed since plan()). The LoopHub-injected,
  // un-gitignored `.claude/` is dropped first (regenerated on the next `lh dev`) so the
  // no-`--force` `git worktree remove` stays a real guard for any other change — but only when it
  // is a real directory, never a symlink.
  async remove(entry: {
    repoPath: string;
    path: string;
    issue: number;
  }): Promise<{ removed: boolean; reason?: string }> {
    const fresh = await worktreeList(entry.repoPath);
    const match = fresh.find(
      (w) => canonicalPath(w.path) === canonicalPath(entry.path),
    );
    if (!match || worktreeNumberFromBranch(match.branch) !== entry.issue) {
      return {
        removed: false,
        reason: `no longer a loophub-managed worktree for #${entry.issue}`,
      };
    }
    const claudeDir = join(entry.path, ".claude");
    const claudeStat = existsSync(claudeDir) ? lstatSync(claudeDir) : null;
    if (claudeStat?.isDirectory() && !claudeStat.isSymbolicLink()) {
      rmSync(claudeDir, { recursive: true, force: true });
    }
    try {
      await worktreeRemove(entry.repoPath, entry.path);
    } catch (e: any) {
      return {
        removed: false,
        reason: e?.message ?? "git worktree remove failed",
      };
    }
    return { removed: true };
  },

  // Run `git worktree prune` (tidy stale admin entries) for one repo or every registered repo.
  async tidy(repo?: string | null): Promise<void> {
    const repoRows = repo ? [repoOr404(repo)] : S.listRepos("all");
    for (const r of repoRows) await worktreePrune(r.local_path);
  },
};
