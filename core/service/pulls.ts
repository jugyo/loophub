import type { GithubDeps } from "./shared.ts";
import {
  actorFor,
  agentSessionJSON,
  clampPerPage,
  commitLog,
  commitsAhead,
  DEFAULT_LIST_PER_PAGE,
  diffFiles,
  diffStat,
  ensureWritable,
  fileAtRef,
  formatEvent,
  githubPullJSON,
  gitMergePull,
  isGithubRemoteUrl,
  issueOr404,
  MAX_LIST_PER_PAGE,
  paginate,
  parseClosingIssueNumber,
  parseGithubPullNumber,
  pathInDiff,
  pullJSON,
  realGithubDeps,
  remoteUrl,
  repoJSON,
  repoOr404,
  revParse,
  S,
  ServiceError,
} from "./shared.ts";

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
  // Thin lookup for callers outside core/ (lh-worker's workflow dispatch) that only need a PR's
  // head ref for a given repo + issue number, not the full serialized pull.
  headRefForNumber(repoId: number, number: number): string | null {
    const issue = S.getIssue(repoId, number);
    if (!issue) return null;
    return S.getPull(issue.id)?.head_ref ?? null;
  },

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
        const p = S.getPull(row.id)!;
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
    // has one. This is the double-`lh dev` guard (not a DB constraint — see #186), so it
    // can be relaxed later to allow multiple proposal PRs per issue.
    const linkedIssueId = resolveLinkedIssueId(r, body, issue);
    const linkedNumber = issue ?? parseClosingIssueNumber(body);
    // Create the issue row first so a PR-number-derived head (headFromNumber) can be computed
    // from its assigned number; a plain string head is unaffected by this reordering. The head
    // branch itself need not exist yet in git — revParse resolves a null sha for a missing ref
    // rather than throwing, which is what lets `lh dev` open the PR before the branch/worktree
    // exist (#463).
    const row = S.createIssue(r.id, "pull", title, body, actor);
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
    return pullJSON(r, S.getIssue(r.id, row.number)!);
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
    const p = S.getPull(row.id)!;
    if (p?.merged && patch.state !== undefined) {
      throw new ServiceError(405, "Pull Request is already merged");
    }
    const actor = actorFor(sessionId);
    const issuePatch: Parameters<typeof S.updateIssue>[1] = {
      title: patch.title,
      body: patch.body,
      state: patch.state as "open" | "closed" | undefined,
    };
    S.updateIssue(row.id, issuePatch);
    S.emitEvent(r.id, "pull_request.updated", actor, { number: row.number });
    return pullJSON(r, S.getIssue(r.id, row.number)!);
  },

  async files(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const p = S.getPull(row.id)!;
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
    const p = S.getPull(row.id)!;
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

    const p = S.getPull(row.id)!;
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
    const p = S.getPull(row.id)!;
    if (p.merged) throw new ServiceError(405, "Pull Request is already merged");
    // A diff-free PR (base..head empty) has nothing to merge — the UI disables the Merge
    // button for this state (#691), but merge-tree itself does not reject it (a diff-free
    // tree merges cleanly), so this check must be enforced here too. Only run it when both
    // refs actually resolve (mirroring serialize.ts's headSha/baseSha guard) — an unresolvable
    // ref isn't "no commits", it's a broken branch, and should fall through to gitMergePull's
    // own "Merge failed" below rather than report a misleading reason.
    const [headSha, baseSha] = await Promise.all([
      revParse(r.local_path, p.head_ref),
      revParse(r.local_path, p.base_ref),
    ]);
    if (headSha && baseSha) {
      const ahead = await commitsAhead(r.local_path, p.base_ref, p.head_ref);
      if (ahead === 0)
        throw new ServiceError(422, "Pull Request has no commits to merge");
    }
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
    const p = S.getPull(row.id)!;
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
      return pullJSON(r, S.getIssue(r.id, row.number)!);
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
    return pullJSON(r, S.getIssue(r.id, row.number)!);
  },

  // Read-only debug dump: every piece of data a PR can be reached from, gathered into one
  // object so a maintainer can inspect raw DB rows + git facts on a single screen (#248).
  // Intentionally returns near-raw rows (not the trimmed wire serializers) — this is a debug
  // surface, so more fields beat a clean shape. Git lookups degrade to nulls on a missing ref
  // rather than throwing, so the dump still renders for a half-set-up PR.
  async debug(name: string, number: number) {
    const r = repoOr404(name);
    const issueRow = issueOr404(r, number, "pull");
    const pull = S.getPull(issueRow.id)!;
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
    ).map((row) => formatEvent(row, r.full_name));

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
