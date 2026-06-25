// Service layer: transport-neutral procedures over the store. Each procedure validates
// input (throwing ServiceError with an HTTP-style status), mutates the store, emits
// events, and returns serialized wire objects. The CLI calls these directly (S5); the
// JSON-RPC layer (S2) will wrap the same procedures. No HTTP/Request types leak in here.
import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ServiceError } from "./errors.ts";
import { formatEvent, type LoopEvent } from "./event-hub.ts";
import {
  branchExists,
  defaultBranch,
  diffFiles,
  mergePull as gitMergePull,
  isGitRepo,
  revParse,
  worktreeList,
  worktreePrune,
  worktreeRemove,
  worktreeStatus,
} from "./git.ts";
import { parseClosingIssueNumber } from "./links.ts";
import {
  agentSessionJSON,
  commentJSON,
  issueJSON,
  labelJSON,
  pullJSON,
  repoJSON,
  reviewCommentJSON,
  reviewJSON,
} from "./serialize.ts";
import * as S from "./store.ts";
import { sweepPullUpdates } from "./watcher.ts";
import {
  classifyWorktree,
  issueNumberFromBranch,
  porcelainIsDirty,
} from "./worktree-prune.ts";

export const MAX_EVENTS_PER_PAGE = 100;
export const DEFAULT_LIST_PER_PAGE = 30;
export const MAX_LIST_PER_PAGE = 100;

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

// ===== agent sessions =====
export const sessions = {
  register(input: {
    id: string;
    agent: string;
    session: string;
    name?: string | null;
  }) {
    const { id, agent, session, name } = input;
    if (!id || !agent || !session)
      throw new ServiceError(422, "id, agent, and session are required");
    try {
      const { session: row, created } = S.registerAgentSession(
        id,
        agent,
        session,
        name ?? null,
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

  list() {
    return S.listAgentSessions().map(agentSessionJSON);
  },

  get(id: string) {
    const row = S.getAgentSession(id);
    if (!row) throw new ServiceError(404, "Not Found");
    return agentSessionJSON(row);
  },
};

// ===== issues =====
export const issues = {
  list(
    name: string,
    opts: {
      state?: string;
      kind?: "issue" | "pull" | "any";
      labels?: string[];
      assignee_session_id?: string | null;
      page?: number;
      perPage?: number;
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
    let rows = S.listIssues(r.id, kind, state);
    if (labelsFilter.length) {
      rows = rows.filter((row) => {
        const names = S.issueLabels(row.id).map((l: any) => l.name);
        return labelsFilter.every((l) => names.includes(l));
      });
    }
    if (
      opts.assignee_session_id !== undefined &&
      opts.assignee_session_id !== null
    ) {
      rows = rows.filter(
        (row) => row.assignee_session_id === opts.assignee_session_id,
      );
    }
    return paginate(rows, perPage, page).map((row) => issueJSON(row, r));
  },

  get(name: string, number: number) {
    const r = repoOr404(name);
    return issueJSON(issueOr404(r, number), r);
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

  assign(name: string, number: number, sessionId: string) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    if (!sessionId) throw new ServiceError(422, "session_id is required");
    const already = row.assignee_session_id === sessionId;
    try {
      S.assignIssueToSession(row.id, sessionId);
    } catch (e: any) {
      if (e.message === "NOT_FOUND")
        throw new ServiceError(404, "Agent session not found");
      if (
        e.message === "CONFLICT_ASSIGNED" ||
        e.message === "CONFLICT_SESSION"
      ) {
        throw new ServiceError(409, "Issue assignee conflict");
      }
      throw e;
    }
    if (!already) {
      S.emitEvent(r.id, "issue.assigned", actorFor(sessionId), {
        number: row.number,
        session_id: sessionId,
        assignee: S.assigneeJSON(sessionId),
      });
    }
    return issueJSON(S.getIssue(r.id, row.number), r);
  },

  unassign(name: string, number: number, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    const actor = actorFor(sessionId);
    try {
      const prev = S.unassignIssue(row.id, sessionId ?? undefined);
      if (prev) {
        S.emitEvent(r.id, "issue.unassigned", actor, {
          number: row.number,
          session_id: prev,
          assignee: S.assigneeJSON(prev),
        });
      }
    } catch (e: any) {
      if (e.message === "CONFLICT_ASSIGNED")
        throw new ServiceError(409, "Issue assignee conflict");
      throw e;
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
};

// ===== labels =====
export const labels = {
  list(name: string) {
    const r = repoOr404(name);
    return S.listLabels(r.id).map(labelJSON);
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
    return pullJSON(r, issueOr404(r, number, "pull"));
  },

  async create(
    name: string,
    input: {
      title: string;
      body?: string;
      head: string;
      base: string;
      issue?: number;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const { title, body = "", head, base, issue } = input;
    if (!title || !head || !base)
      throw new ServiceError(422, "title, head, base are required");
    const actor = actorFor(sessionId);
    const linkedIssueId = resolveLinkedIssueId(r, body, issue);
    const linkedNumber = issue ?? parseClosingIssueNumber(body);
    const row = S.createIssue(r.id, "pull", title, body, actor) as any;
    const headSha = await revParse(r.local_path, head);
    S.createPull(row.id, head, base, headSha, linkedIssueId);
    S.emitEvent(r.id, "pull_request.opened", actor, {
      number: row.number,
      linked_issue: linkedNumber ?? undefined,
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
    const latest = S.latestSubstantiveReview(row.id);
    if (latest?.event !== "REQUEST_CHANGES") {
      throw new ServiceError(422, "No pending change requests to address");
    }
    if (p.changes_addressed_at)
      throw new ServiceError(422, "Already marked ready for re-review");
    const actor = actorFor(sessionId);
    S.markChangesAddressed(row.id, actor);
    const headSha = await revParse(r.local_path, p.head_ref);
    if (headSha) S.setHeadSha(row.id, headSha);
    if (body) S.createComment(row.id, actor, body);
    S.emitEvent(r.id, "pull_request.ready_for_review", actor, {
      number: row.number,
    });
    return pullJSON(r, S.getIssue(r.id, row.number));
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
  // overwrites; `Closes #<n>` links it both ways.
  async openPr(
    name: string,
    input: { issue: number; head: string; base: string; body?: string },
    sessionId?: string | null,
  ): Promise<{ created: boolean; number: number }> {
    const r = repoOr404(name);
    ensureWritable(r);
    const issueRow = issueOr404(r, input.issue, "issue");
    const existing = S.openPullLinkedToIssue(issueRow.id);
    if (existing) return { created: false, number: existing.number };
    const body = input.body ?? defaultDraftPrBody(input.issue);
    const pr = await pulls.create(
      name,
      {
        title: issueRow.title,
        body,
        head: input.head,
        base: input.base,
        issue: input.issue,
      },
      sessionId,
    );
    return { created: true, number: pr.number };
  },

  // Record a development note (decision / action / assumption / blocker) as a `dev.note`
  // event in the shared events table. The note targets an issue and/or a PR; the missing
  // side is resolved when possible (a PR's linked issue, or an issue's open linked PR).
  log(
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
      comments?: { path: string; line?: number; side?: string; body: string }[];
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const event = (input.event ?? "COMMENT").toUpperCase();
    const lineComments = Array.isArray(input.comments) ? input.comments : [];
    for (const cm of lineComments) {
      if (!cm?.path || !cm?.body)
        throw new ServiceError(422, "each comment requires path and body");
    }
    const actor = actorFor(sessionId);
    const v = S.createReview(row.id, actor, event, input.body ?? "") as any;
    for (const cm of lineComments) {
      S.createReviewComment(row.id, v.id, actor, {
        path: cm.path,
        line: cm.line,
        side: cm.side,
        body: cm.body,
      });
    }
    if (event === "APPROVE" || event === "REQUEST_CHANGES")
      S.clearChangesAddressed(row.id);
    S.emitEvent(r.id, "pull_request.review_submitted", actor, {
      number: row.number,
      state: event,
      comments: lineComments.length,
    });
    return { ...reviewJSON(v), comments: lineComments.length };
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

function byUpdatedDesc(
  a: { updated_at: string },
  b: { updated_at: string },
): number {
  return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
}

function byCreatedDesc(
  a: { created_at: string },
  b: { created_at: string },
): number {
  return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
}

// Per-section cap for the open-PR list, mirroring the per-repo dashboard
// sections. Bounds both the rendered list and the git fan-out below: rows are
// sorted and sliced *before* serialization, so at most this many pullJSON
// (git-spawning) calls run per request regardless of total backlog size.
export const DASHBOARD_SECTION_LIMIT = 50;

// Cap for the cross-repo "recently created open issues" list. Higher than the
// PR cap because issues are cheap to serialize (no git fan-out).
export const DASHBOARD_RECENT_ISSUES_LIMIT = 100;

export const dashboard = {
  async overview() {
    const issueRows: { repo: S.Repo; ref: RepoRef; row: any }[] = [];
    const pullRows: { repo: S.Repo; ref: RepoRef; row: any }[] = [];
    for (const r of S.listRepos("active")) {
      const ref = repoRef(r);
      for (const row of S.listIssues(r.id, "issue", "open")) {
        issueRows.push({ repo: r, ref, row });
      }
      for (const row of S.listPulls(r.id, "open", "exclude")) {
        pullRows.push({ repo: r, ref, row });
      }
    }
    // Cap each section before serialization so the lists stay bounded and
    // pullJSON's git fan-out stays bounded. Issues are ordered newest-created
    // first; PRs keep their most-recently-updated ordering.
    issueRows.sort((a, b) => byCreatedDesc(a.row, b.row));
    pullRows.sort((a, b) => byUpdatedDesc(a.row, b.row));
    const issues = issueRows
      .slice(0, DASHBOARD_RECENT_ISSUES_LIMIT)
      .map(({ repo, ref, row }) => ({
        repo: ref,
        issue: issueJSON(row, repo),
      }));
    const pulls = await Promise.all(
      pullRows
        .slice(0, DASHBOARD_SECTION_LIMIT)
        .map(async ({ repo, ref, row }) => ({
          repo: ref,
          pull: await pullJSON(repo, row),
        })),
    );
    return { issues, pulls };
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
// Batch GC of stale `lh dev` worktrees (branch `loophub/issue-<n>`). The orchestration —
// scanning git worktrees, resolving each one's issue/PR state, and the destructive removal —
// lives here so the CLI stays a thin presenter and the logic is unit-testable. Pure decisioning
// (clean-tree guard, keep/remove/skip classification) stays in worktree-prune.ts.
export interface WorktreePlanEntry {
  repo: string; // owner/name
  repoPath: string; // primary checkout (shared .git)
  path: string; // worktree directory
  branch: string;
  issue: number;
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
        const n = issueNumberFromBranch(wt.branch);
        if (n == null) continue; // primary checkout / off-convention worktrees are not ours

        let issueState: "open" | "closed" | null = null;
        let prMerged = false;
        let prState: "open" | "closed" | null = null;
        // Done-ness comes from the row's own state (an `lh dev` worktree branch maps to an
        // issue, but read state for any row so a number that resolves to a pull behaves as it
        // did pre-refactor). A merged linked PR is only meaningful for an issue row.
        const row = S.getIssue(r.id, n);
        if (row) {
          issueState = row.state;
          if (row.kind === "issue") {
            const pr = S.linkedPullForIssue(row.id);
            if (pr) {
              prMerged = !!pr.merged;
              prState = pr.state;
            }
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
  // call: it must still be a registered worktree on its `loophub/issue-<n>` branch (state may
  // have changed since plan()). The LoopHub-injected, un-gitignored `.claude/` is dropped first
  // (regenerated on the next `lh dev`) so the no-`--force` `git worktree remove` stays a real
  // guard for any other change — but only when it is a real directory, never a symlink.
  async remove(entry: {
    repoPath: string;
    path: string;
    issue: number;
  }): Promise<{ removed: boolean; reason?: string }> {
    const fresh = await worktreeList(entry.repoPath);
    const match = fresh.find(
      (w) => canonicalPath(w.path) === canonicalPath(entry.path),
    );
    if (!match || issueNumberFromBranch(match.branch) !== entry.issue) {
      return {
        removed: false,
        reason: `no longer a loophub/issue-${entry.issue} worktree`,
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
