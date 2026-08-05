import { randomUUID } from "node:crypto";
import { db } from "../db.ts";
import { publish } from "../domain-events.ts";
import { ServiceError } from "../errors.ts";
import {
  type GithubIssueDeps,
  parseGithubIssueUrl,
  realGithubIssueDeps,
} from "../github.ts";
import {
  acceptanceCriterionDetailJSON,
  acceptanceCriterionJSON,
  commentJSON,
  githubIssueJSON,
  herdrPaneJSON,
  type IssueRefKindWire,
  issueJSON,
  issueRefKindJSON,
  labelJSON,
  relatedSessionsJSON,
} from "../serialize.ts";
import { issueDetailJSON, issueListItemsJSON } from "../serialize-status.ts";
import * as S from "../store.ts";
import {
  actorFor,
  assertExistingLocalBranch,
  clampPerPage,
  DEFAULT_LIST_PER_PAGE,
  ensureWritable,
  issueOr404,
  localBranchExists,
  MAX_LIST_PER_PAGE,
  paginate,
  repoOr404,
} from "./shared.ts";

const ISSUE_LIST_LOOKAHEAD_MAX = MAX_LIST_PER_PAGE + 1;

export interface CurrentHerdrPaneContext {
  sessionName: string;
  paneId: string;
  launchId?: string | null;
}

type TargetBranchInput = {
  workspace?: string | null;
  target_branch?: string | null;
};

function resolveTargetBranch(
  repo: S.Repo,
  input: TargetBranchInput,
): string | null | undefined {
  let workspace: string | null = null;
  if (input.workspace !== undefined && input.workspace !== null) {
    if (typeof input.workspace !== "string" || !input.workspace.trim()) {
      throw new ServiceError(422, "workspace branch is required");
    }
    workspace = input.workspace.trim();
  }
  const explicitTargetBranch = input.target_branch?.trim() || null;
  if (workspace && explicitTargetBranch) {
    throw new ServiceError(
      422,
      "workspace cannot be combined with target_branch",
    );
  }
  if (workspace) {
    const registered = S.getWorkspace(repo.id, workspace);
    if (!registered || registered.archived_at) {
      throw new ServiceError(
        422,
        `workspace must name an active registered workspace: ${workspace}`,
      );
    }
    if (!localBranchExists(repo.local_path, workspace)) {
      throw new ServiceError(
        422,
        `workspace branch must exist locally: ${workspace}`,
      );
    }
  }
  const targetBranch = workspace ?? explicitTargetBranch;
  if (targetBranch) assertExistingLocalBranch(repo.local_path, targetBranch);
  return input.workspace !== undefined || input.target_branch !== undefined
    ? targetBranch
    : undefined;
}

function linkIssueToCurrentPane(
  repoId: number,
  issueId: number,
  currentPane: CurrentHerdrPaneContext,
): void {
  let pane = currentPane.launchId
    ? S.getHerdrPaneByLaunch(repoId, currentPane.launchId)
    : null;
  pane ??= S.getHerdrPaneByCoordinates(
    repoId,
    currentPane.sessionName,
    currentPane.paneId,
  );
  if (!pane) {
    pane = S.registerHerdrPane({
      repoId,
      launchId: currentPane.launchId ?? randomUUID(),
      paneId: currentPane.paneId,
      sessionName: currentPane.sessionName,
      displayName: currentPane.launchId ? "New issue" : null,
      origin: currentPane.launchId ? "issue-create" : "external",
      lifecycleManaged: currentPane.launchId != null,
    });
  } else if (
    currentPane.launchId &&
    pane.launch_id === currentPane.launchId &&
    (pane.pane_id == null || pane.session_name == null || pane.origin == null)
  ) {
    pane = S.registerHerdrPane({
      repoId,
      launchId: pane.launch_id,
      paneId: currentPane.paneId,
      sessionName: currentPane.sessionName,
      displayName: pane.display_name ?? "New issue",
      origin: pane.origin ?? "issue-create",
      lifecycleManaged: pane.lifecycle_managed === 1 || pane.origin == null,
    });
  }
  S.linkIssueFiledFromHerdrPane({
    repoId,
    launchId: pane.launch_id,
    issueId,
  });
}

// Resolve a public `<issue-number>-<ac-number>` reference (or the issue-scoped `ac-<number>`
// shorthand) to its internal row. Repository and issue scope are enforced here for every caller;
// internal integer ids never enter or leave this service boundary.
function acceptanceCriterionInRepoOr404(
  repo: S.Repo,
  criterionRef: string,
  issueNumber?: number,
): S.AcceptanceCriterionRow {
  let criterion: S.AcceptanceCriterionRow | null = null;
  if (/^([1-9]\d*)-([1-9]\d*)$/.test(criterionRef)) {
    const [, referencedIssueNumber, criterionNumber] = criterionRef.match(
      /^([1-9]\d*)-([1-9]\d*)$/,
    )!;
    const referencedIssue = S.getIssue(repo.id, Number(referencedIssueNumber));
    if (
      referencedIssue &&
      (issueNumber == null || referencedIssue.number === issueNumber)
    ) {
      criterion = S.getAcceptanceCriterionByNumber(
        referencedIssue.id,
        Number(criterionNumber),
      );
    }
  } else if (issueNumber != null && /^ac-[1-9]\d*$/.test(criterionRef)) {
    const issue = issueOr404(repo, issueNumber);
    criterion = S.getAcceptanceCriterionByNumber(
      issue.id,
      Number(criterionRef.slice(3)),
    );
  } else {
    throw new ServiceError(
      422,
      "acceptance criterion reference must be <issue-number>-<ac-number> or ac-<number> with an issue",
    );
  }
  const issue = criterion ? S.getIssueById(criterion.issue_id) : null;
  if (
    !criterion ||
    !issue ||
    issue.repo_id !== repo.id ||
    (issueNumber != null && issue.number !== issueNumber)
  ) {
    throw new ServiceError(
      404,
      `acceptance criterion ${criterionRef} not found`,
    );
  }
  return criterion;
}

// ===== issues =====
export const issues = {
  async list(
    name: string,
    opts: {
      state?: string;
      kind?: "issue" | "pull" | "any";
      labels?: string[];
      workspace?: string;
      lookahead?: boolean;
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
      ISSUE_LIST_LOOKAHEAD_MAX,
    );
    const page = opts.page && opts.page >= 1 ? opts.page : 1;
    let rows = S.listIssues(r.id, kind, state, opts.sort ?? "created");
    if (labelsFilter.length) {
      const matchingIssueIds = S.issueIdsWithLabels(r.id, labelsFilter);
      rows = rows.filter((row) => matchingIssueIds.has(row.id));
    }
    if (opts.workspace) {
      rows = rows.filter((row) => {
        const targetBranch = row.target_branch?.trim();
        return opts.workspace === r.default_branch
          ? !targetBranch || targetBranch === r.default_branch
          : targetBranch === opts.workspace;
      });
    }
    // Enrich each issue's linked PR with status (working / review / mergeable /
    // diff totals) for the issue-list sub-row. Async git fan-out, bounded by the
    // pagination slice above; other surfaces keep the sync issueJSON summary.
    // A lookahead page returns one extra row so the caller can decide whether
    // to offer another page. Advance by the visible size so that extra row
    // becomes the first visible row on the next page. Keep the legacy 101-row
    // request compatible with the original 100-row issue list.
    const pageRows =
      (opts.lookahead && perPage > 1) || perPage === ISSUE_LIST_LOOKAHEAD_MAX
        ? rows.slice(
            (page - 1) * (perPage - 1),
            (page - 1) * (perPage - 1) + perPage,
          )
        : paginate(rows, perPage, page);
    const issueIds = pageRows.map((row) => row.id);
    return issueListItemsJSON(pageRows, r, {
      labelsByIssue: S.labelsByIssue(issueIds),
      commentCountsByIssue: S.commentCountsByIssue(issueIds),
      linkedPullsByIssue: S.linkedPullsByIssue(issueIds),
      herdrPanesByIssue: S.issueHerdrPanesByIssue(r.id, issueIds),
    });
  },

  // Issue detail. Unlike the list/summary `issueJSON` (where `comments` is just a count),
  // the detail also carries `comment_list` — the full comment bodies (author, time, text) — so
  // an implementation agent reading an issue via `lh issue view --json` gets the design context
  // people leave in comments, not only the body (#231). The summary path stays a count to keep
  // the issue list cheap.
  async get(
    name: string,
    number: number,
    opts: { withComments?: boolean; withAcceptanceCriteria?: boolean } = {},
  ) {
    const r = repoOr404(name);
    const row = issueOr404(r, number);
    const out = await issueDetailJSON(row, r);
    if (opts.withComments !== false) {
      const reactions = S.commentReactionsByIssue(row.id);
      out.comment_list = S.listComments(row.id).map((comment) =>
        commentJSON(comment, reactions.get(comment.id) ?? []),
      );
    }
    // Detail-only (#298): the issue's related sessions, newest first.
    out.related_sessions = relatedSessionsJSON(row);
    // Detail-only (#614): the GitHub issue this one was imported from, or null. Mirrors how PR detail
    // surfaces github_pull; kept off the cheap list serializer.
    out.github_issue = githubIssueJSON(S.getGithubIssue(row.id));
    out.herdr_pane = herdrPaneJSON(S.getIssueHerdrPane(row.id));
    // Structured acceptance criteria (#1894), enabled only — the rubric a later Verify slice grades.
    // Detail-only, like comment_list. Omitted from the cheap list/summary serializer.
    if (opts.withAcceptanceCriteria !== false) {
      out.acceptance_criteria = S.listAcceptanceCriteria(row.id)
        .filter((c) => c.enabled === 1)
        .map((criterion) => acceptanceCriterionJSON(criterion, row.number));
    }
    return out;
  },

  /**
   * Kind of each referenced number, for rendering `#n` and `owner/repo#n` in a Markdown body as
   * a link to the canonical issue or pull route (#2362). References come grouped by the repo
   * they point at, so one body needs one lookup however many repos it names. A repo that is not
   * registered here is skipped rather than a 404, the same way a number with no Issue or PR is
   * absent from the result: a body may name anything, and the caller renders what it cannot
   * resolve as plain text.
   */
  refKinds(targets: { repo: string; numbers: number[] }[]): IssueRefKindWire[] {
    const out: IssueRefKindWire[] = [];
    for (const target of targets) {
      const r = S.getRepo(...S.splitName(target.repo));
      if (!r) continue;
      const wanted = [
        ...new Set(target.numbers.filter((n) => Number.isInteger(n) && n > 0)),
      ];
      for (const row of S.listIssueKinds(r.id, wanted)) {
        out.push(issueRefKindJSON(target.repo, row));
      }
    }
    return out;
  },

  create(
    name: string,
    input: {
      title: string;
      body?: string;
      labels?: string[];
      workspace?: string | null;
      target_branch?: string | null;
      acceptance_criteria?: string[];
    },
    sessionId?: string | null,
    currentPane?: CurrentHerdrPaneContext | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    if (!input.title) throw new ServiceError(422, "title is required");
    const actor = actorFor(sessionId);
    // The branch validation shells out to git, so it must finish before the DB phase below.
    const targetBranch = resolveTargetBranch(r, input) ?? null;
    return db.transaction(() => {
      const issue = S.createIssue(
        r.id,
        "issue",
        input.title,
        input.body ?? "",
        actor,
        targetBranch,
      );
      if (input.labels?.length) S.setLabels(r.id, issue.id, input.labels);
      // Structured acceptance criteria (#1894): appended in given order, blanks dropped. Each gets a
      // stable id at insert; the markdown `## Acceptance criteria` section is never parsed.
      for (const text of input.acceptance_criteria ?? []) {
        const trimmed = text.trim();
        if (trimmed) S.addAcceptanceCriterion(issue.id, trimmed);
      }
      if (currentPane) linkIssueToCurrentPane(r.id, issue.id, currentPane);
      S.emitEvent(r.id, "issue.opened", actor, { number: issue.number });
      return issueJSON(S.getIssue(r.id, issue.number)!, r);
    });
  },

  // #614: import a GitHub issue into this repo as a loophub issue — copy its title/body verbatim (no
  // summarization) and record the GitHub source link. Orchestration lives here (parse → fetch → create
  // → link → event), CLI stays thin (AGENTS.md). `deps.fetchIssue` is an injectable seam so the flow is
  // unit-testable without `gh`/network; callers leave it at the default. The import always creates a
  // fresh loophub issue — importing the same GitHub issue twice yields two linked loophub issues (the
  // many-to-one link is intentional, per the issue's AC).
  async import(
    name: string,
    input: { url: string },
    sessionId?: string | null,
    deps: GithubIssueDeps = realGithubIssueDeps,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const ref = parseGithubIssueUrl(input.url ?? "");
    if (!ref)
      throw new ServiceError(
        422,
        "url must be a GitHub issue URL (https://github.com/<owner>/<repo>/issues/<number>)",
      );
    let gh: Awaited<ReturnType<typeof deps.fetchIssue>>;
    try {
      // Run `gh` from the destination repo's checkout (like the rest of github.ts), not the caller's
      // cwd; `--repo` still makes the parsed coordinates authoritative.
      gh = await deps.fetchIssue(r.local_path, ref);
    } catch (e) {
      throw new ServiceError(
        502,
        `failed to fetch GitHub issue: ${(e as Error).message}`,
      );
    }
    const actor = actorFor(sessionId);
    // The GitHub fetch above is already done; only the synchronous DB phase is transactional.
    return db.transaction(() => {
      const issue = S.createIssue(r.id, "issue", gh.title, gh.body, actor);
      const link = S.recordGithubIssue({
        issueId: issue.id,
        owner: ref.owner,
        repo: ref.repo,
        number: ref.number,
        url: gh.url || input.url.trim(),
        createdBy: actor,
      });
      // Emit issue.opened (not a bespoke issue.imported): an imported issue is a normal newly-opened
      // loophub issue, so it must reach the same consumers as `create` — chiefly the workflow worker,
      // which only dispatches on SUPPORTED_EVENTS (issue.opened / pull_request.opened, see workflow.ts).
      // The `github` field marks the import in the event stream without diverging the event type.
      S.emitEvent(r.id, "issue.opened", actor, {
        number: issue.number,
        github: `${ref.owner}/${ref.repo}#${ref.number}`,
      });
      const out = issueJSON(S.getIssue(r.id, issue.number)!, r);
      out.github_issue = githubIssueJSON(link);
      return out;
    });
  },

  // Plain edits only (title/body/state/labels/target branch). Assignment has dedicated procedures.
  update(
    name: string,
    number: number,
    patch: {
      title?: string;
      body?: string;
      state?: string;
      labels?: string[];
      workspace?: string | null;
      target_branch?: string | null;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    const targetBranchChanged =
      patch.workspace !== undefined || patch.target_branch !== undefined;
    if (targetBranchChanged && row.kind === "pull") {
      throw new ServiceError(422, "target branch cannot be changed for a pull");
    }
    if (
      patch.state !== undefined &&
      patch.state !== "open" &&
      patch.state !== "closed"
    ) {
      throw new ServiceError(422, 'state must be "open" or "closed"');
    }
    const state = patch.state as "open" | "closed" | undefined;
    const actor = actorFor(sessionId);
    const wasOpen = row.state === "open";
    // The branch validation shells out to git, so it must finish before the DB phase below. Closing
    // an issue also closes its open linked PRs, so that cascade shares this one transaction.
    const targetBranch = resolveTargetBranch(r, patch);

    return db.transaction(() => {
      const fields: Parameters<typeof S.updateIssue>[1] = {};
      if (patch.title !== undefined) fields.title = patch.title;
      if (patch.body !== undefined) fields.body = patch.body;
      if (state !== undefined) fields.state = state;
      if (targetBranch !== undefined) fields.target_branch = targetBranch;
      if (Object.keys(fields).length) S.updateIssue(row.id, fields);
      if (patch.labels !== undefined) {
        S.setLabels(r.id, row.id, patch.labels);
        S.emitEvent(r.id, "issue.labeled", actor, {
          number: row.number,
          labels: patch.labels,
        });
      }
      if (state === "closed" && wasOpen) {
        if (row.kind === "pull") {
          publish({
            type: "pull.closed",
            repoId: r.id,
            actor,
            pullId: row.id,
            pullNumber: row.number,
            linkedIssueId: S.getPull(row.id)?.linked_issue_id ?? null,
            reason: { kind: "manual" },
          });
        } else {
          publish({
            type: "issue.closed",
            repoId: r.id,
            actor,
            issueId: row.id,
            issueNumber: row.number,
            reason: { kind: "manual" },
          });
        }
      } else if (state === "open" && !wasOpen) {
        S.emitEvent(
          r.id,
          row.kind === "pull" ? "pull_request.updated" : "issue.reopened",
          actor,
          {
            number: row.number,
          },
        );
      }
      if (
        patch.title !== undefined ||
        patch.body !== undefined ||
        targetBranchChanged
      ) {
        S.emitEvent(
          r.id,
          row.kind === "pull" ? "pull_request.updated" : "issue.updated",
          actor,
          {
            number: row.number,
          },
        );
      }
      return issueJSON(S.getIssue(r.id, row.number)!, r);
    });
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
    return db.transaction(() => {
      S.addLabels(r.id, row.id, names);
      S.emitEvent(r.id, "issue.labeled", actor, {
        number: row.number,
        labels: names,
      });
      return S.issueLabels(row.id).map(labelJSON);
    });
  },

  // Structured acceptance criteria authoring (#1894). The list returns disabled criteria too —
  // `acListJSON` carries `enabled` so CLI and Web operators can see and re-enable them. There is
  // deliberately no delete: an unwanted criterion is disabled.
  acList(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number);
    return S.listAcceptanceCriteria(row.id).map((criterion) =>
      acceptanceCriterionDetailJSON(criterion, row.number),
    );
  },

  acAdd(name: string, number: number, text: string) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    const trimmed = text?.trim();
    if (!trimmed) {
      throw new ServiceError(422, "acceptance criterion text is required");
    }
    return db.transaction(() => {
      const created = S.addAcceptanceCriterion(row.id, trimmed);
      S.touchIssue(row.id);
      return acceptanceCriterionDetailJSON(created, row.number);
    });
  },

  acSetEnabled(
    name: string,
    criterionRef: string,
    enabled: boolean,
    issueNumber?: number,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const criterion = acceptanceCriterionInRepoOr404(
      r,
      criterionRef,
      issueNumber,
    );
    return db.transaction(() => {
      S.setAcceptanceCriterionEnabled(criterion.id, enabled);
      S.touchIssue(criterion.issue_id);
      return acceptanceCriterionDetailJSON(
        S.getAcceptanceCriterion(criterion.id)!,
        S.getIssueById(criterion.issue_id)!.number,
      );
    });
  },

  // Reorder rewrites `ordinal`; internal ids stay fixed so future grades stay attached. The public
  // refs must cover every criterion exactly once — a partial or unknown ref is a visible error.
  acReorder(name: string, number: number, orderedRefs: string[]) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number);
    const orderedIds = orderedRefs.map(
      (ref) => acceptanceCriterionInRepoOr404(r, ref, number).id,
    );
    const existingIds = S.listAcceptanceCriteria(row.id).map((c) => c.id);
    const existingSet = new Set(existingIds);
    const orderedSet = new Set(orderedIds);
    const isPermutation =
      orderedIds.length === existingIds.length &&
      orderedSet.size === orderedIds.length &&
      orderedIds.every((id) => existingSet.has(id));
    if (!isPermutation) {
      throw new ServiceError(
        422,
        "order must list every acceptance criterion reference of this issue exactly once",
      );
    }
    return db.transaction(() => {
      S.reorderAcceptanceCriteria(row.id, orderedIds);
      S.touchIssue(row.id);
      return S.listAcceptanceCriteria(row.id).map((criterion) =>
        acceptanceCriterionDetailJSON(criterion, row.number),
      );
    });
  },
};
