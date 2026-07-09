import type { GithubIssueDeps } from "./shared.ts";
import {
  actorFor,
  assertExistingLocalBranch,
  clampPerPage,
  commentJSON,
  DEFAULT_LIST_PER_PAGE,
  ENV_ISSUE_CREATE_HERDR_LAUNCH,
  ensureWritable,
  githubIssueJSON,
  herdrPaneJSON,
  issueJSON,
  issueListItemJSON,
  issueOr404,
  labelJSON,
  MAX_LIST_PER_PAGE,
  paginate,
  parseGithubIssueUrl,
  realGithubIssueDeps,
  relatedSessionsJSON,
  repoOr404,
  S,
  ServiceError,
} from "./shared.ts";

const ISSUE_LIST_LOOKAHEAD_MAX = MAX_LIST_PER_PAGE + 1;

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
      ISSUE_LIST_LOOKAHEAD_MAX,
    );
    const page = opts.page && opts.page >= 1 ? opts.page : 1;
    let rows = S.listIssues(r.id, kind, state, opts.sort ?? "created");
    if (labelsFilter.length) {
      rows = rows.filter((row) => {
        const names = S.issueLabels(row.id).map((l) => l.name);
        return labelsFilter.every((l) => names.includes(l));
      });
    }
    // Enrich each issue's linked PR with status (working / review / mergeable /
    // diff totals) for the issue-list sub-row. Async git fan-out, bounded by the
    // pagination slice above; other surfaces keep the sync issueJSON summary.
    // The repo issue list asks for 101 rows to render 100 and use one as
    // lookahead, so those pages advance by the visible page size.
    const pageRows =
      perPage === ISSUE_LIST_LOOKAHEAD_MAX
        ? rows.slice(
            (page - 1) * MAX_LIST_PER_PAGE,
            (page - 1) * MAX_LIST_PER_PAGE + perPage,
          )
        : paginate(rows, perPage, page);
    return Promise.all(pageRows.map((row) => issueListItemJSON(row, r)));
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
    // Detail-only (#614): the GitHub issue this one was imported from, or null. Mirrors how PR detail
    // surfaces github_pull; kept off the cheap list serializer.
    out.github_issue = githubIssueJSON(S.getGithubIssue(row.id));
    out.herdr_pane = herdrPaneJSON(S.getIssueHerdrPane(row.id));
    return out;
  },

  create(
    name: string,
    input: {
      title: string;
      body?: string;
      labels?: string[];
      target_branch?: string | null;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    if (!input.title) throw new ServiceError(422, "title is required");
    const actor = actorFor(sessionId);
    const targetBranch = input.target_branch?.trim() || null;
    if (targetBranch) assertExistingLocalBranch(r.local_path, targetBranch);
    const issue = S.createIssue(
      r.id,
      "issue",
      input.title,
      input.body ?? "",
      actor,
      targetBranch,
    );
    if (input.labels?.length) S.setLabels(r.id, issue.id, input.labels);
    const launchId = process.env[ENV_ISSUE_CREATE_HERDR_LAUNCH];
    if (launchId) {
      S.upsertIssueHerdrPane({
        launchId,
        repoId: r.id,
        issueId: issue.id,
      });
    }
    S.emitEvent(r.id, "issue.opened", actor, { number: issue.number });
    return issueJSON(S.getIssue(r.id, issue.number)!, r);
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

    const fields: Parameters<typeof S.updateIssue>[1] = {};
    if (patch.title !== undefined) fields.title = patch.title;
    if (patch.body !== undefined) fields.body = patch.body;
    if (patch.state !== undefined) fields.state = patch.state;
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
    return issueJSON(S.getIssue(r.id, row.number)!, r);
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
    const labels = S.issueLabels(row.id).map((l) => l.name);
    S.emitEvent(r.id, "issue.labeled", actor, { number: row.number, labels });
  },
};
