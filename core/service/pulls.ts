import { join } from "node:path";
import { db } from "../db.ts";
import { parsePatchWithCoordinates } from "../diff-anchor.ts";
import { publish } from "../domain-events.ts";
import { ServiceError } from "../errors.ts";
import { formatEvent } from "../events.ts";
import {
  commitDiffFiles,
  commitInRange,
  commitLog,
  commitsAhead,
  diffFiles,
  diffFilesBetween,
  diffStat,
  fileAtRef,
  mergePull as gitMergePull,
  hasEffectiveDiff,
  type PullMergeMethod,
  pathInDiff,
  remoteUrl,
  revParse,
} from "../git.ts";
import {
  type GithubDeps,
  type GithubPrStatusDeps,
  parseGhPrStatus,
  realGithubDeps,
  realGithubPrStatusDeps,
} from "../github.ts";
import { parseClosingIssueNumber } from "../links.ts";
import { isGithubRemoteUrl, parseGithubPullNumber } from "../merge-mode.ts";
import { resolvePullBaseSha } from "../pull-base.ts";
import { existingPullWorktreePath } from "../pull-worktree.ts";
import {
  agentSessionJSON,
  githubPrStatusJSON,
  githubPullJSON,
  pullUsageJSON,
  repoJSON,
} from "../serialize.ts";
import { pullJSON } from "../serialize-status.ts";
import * as S from "../store.ts";
import { SOURCE_PAYLOAD_VERSION } from "../workflow/source-events.ts";
import {
  actorFor,
  assertExistingLocalBranch,
  clampPerPage,
  DEFAULT_LIST_PER_PAGE,
  ensureWritable,
  gitActorFor,
  issueOr404,
  MAX_LIST_PER_PAGE,
  paginate,
  repoOr404,
} from "./shared.ts";

// #850: how long a cached GitHub PR status is served before hitting `gh` again. On-demand from the
// PR-detail sidebar, so a short TTL keeps the panel roughly live without spawning a `gh` per render.
const GITHUB_PR_STATUS_TTL_MS = 60_000;

interface PullCreateDeps {
  revParse: typeof revParse;
}

const realPullCreateDeps: PullCreateDeps = { revParse };

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
  assertNoOtherOpenPull(row.id, row.number);
  return row.id;
}

function assertNoOtherOpenPull(
  linkedIssueId: number,
  linkedIssueNumber: number,
  pullIssueId?: number,
): void {
  const existing = S.openPullLinkedToIssue(linkedIssueId);
  if (existing && existing.id !== pullIssueId) {
    throw new ServiceError(
      422,
      `issue #${linkedIssueNumber} already has an open pull request`,
    );
  }
}

export const pulls = {
  // Thin lookup for callers outside core/ (lh-worker's workflow dispatch) that only need a PR's
  // head ref for a given repo + issue number, not the full serialized pull.
  headRefForNumber(repoId: number, number: number): string | null {
    const issue = S.getIssue(repoId, number);
    if (!issue) return null;
    return S.getPull(issue.id)?.head_ref ?? null;
  },

  async baseShaForNumber(name: string, number: number): Promise<string | null> {
    const r = repoOr404(name);
    const issue = issueOr404(r, number, "pull");
    return resolvePullBaseSha(r.local_path, S.getPull(issue.id)!);
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

  get(name: string, number: number, opts: { withComments?: boolean } = {}) {
    const r = repoOr404(name);
    return pullJSON(r, issueOr404(r, number, "pull"), {
      withCommits: true,
      withRelatedSessions: true,
      withComments: opts.withComments !== false,
    });
  },

  // #2263: the PR's agent-cost totals alone. Unlike `get`, this path reads only the DB, so the
  // usage counter can tick every few seconds without paying for the PR's git status fan-out.
  usage(name: string, number: number) {
    const r = repoOr404(name);
    return pullUsageJSON(issueOr404(r, number, "pull"));
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
      base?: string;
      issue?: number;
    },
    sessionId?: string | null,
    deps: PullCreateDeps = realPullCreateDeps,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const { title, body = "", issue } = input;
    if (!title || (!input.head && !input.headFromNumber))
      throw new ServiceError(422, "title, head, base are required");
    const actor = actorFor(sessionId);
    // Refuse a second open PR for an issue that already has one. This is the double-start guard for
    // every issue-targeted creation path; historical rows may still contain multiple linked PRs.
    const linkedIssueId = resolveLinkedIssueId(r, body, issue);
    const linkedNumber = issue ?? parseClosingIssueNumber(body);
    const linkedIssue =
      linkedIssueId != null ? S.getIssueById(linkedIssueId) : null;
    const base = input.base ?? linkedIssue?.target_branch ?? r.default_branch;
    if (!base) throw new ServiceError(422, "title, head, base are required");
    assertExistingLocalBranch(
      r.local_path,
      base,
      input.base == null && linkedIssue?.target_branch
        ? "target_branch"
        : "base",
    );
    // A number-derived head needs its stable number before git can observe the ref. Reserve only
    // the number here; the pull-shaped issue itself remains part of the command transaction below.
    // A missing future head resolves to a null sha, which lets openPr create the PR before its
    // branch/worktree exists (#463).
    const reservedNumber = input.headFromNumber
      ? S.reserveIssueNumber(r.id)
      : null;
    const head = input.head ?? input.headFromNumber!(reservedNumber!);
    const [headSha, resolvedBaseSha] = await Promise.all([
      deps.revParse(r.local_path, head),
      deps.revParse(r.local_path, base),
    ]);
    const row = db.transaction(() => {
      const created =
        reservedNumber == null
          ? S.createIssue(r.id, "pull", title, body, actor)
          : S.createIssueWithNumber(
              r.id,
              reservedNumber,
              "pull",
              title,
              body,
              actor,
            );
      S.createPull(
        created.id,
        head,
        base,
        headSha,
        linkedIssueId,
        sessionId ?? null,
        resolvedBaseSha,
        // A PR-number-derived branch is deliberately recorded before it exists so a launcher can
        // provision it. Persist that fact explicitly; nullable head_sha is only watcher data and is
        // not reliable lifecycle provenance.
        input.headFromNumber != null && headSha == null,
      );
      S.emitEvent(r.id, "pull_request.opened", actor, {
        number: created.number,
        linked_issue: linkedNumber ?? undefined,
      });
      return created;
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
    const closesPull = row.state === "open" && patch.state === "closed";
    const issuePatch: Parameters<typeof S.updateIssue>[1] = {
      title: patch.title,
      body: patch.body,
      state: patch.state as "open" | "closed" | undefined,
    };
    const updated = db.transaction(() => {
      S.updateIssue(row.id, issuePatch);
      if (closesPull) {
        publish({
          type: "pull.closed",
          repoId: r.id,
          actor,
          pullId: row.id,
          pullNumber: row.number,
          linkedIssueId: p.linked_issue_id,
          reason: { kind: "manual" },
        });
      } else {
        S.emitEvent(r.id, "pull_request.updated", actor, {
          number: row.number,
        });
      }
      return S.getIssue(r.id, row.number)!;
    });
    return pullJSON(r, updated);
  },

  archive(name: string, number: number, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const actor = actorFor(sessionId);
    db.transaction(() => {
      S.archivePull(row.id);
      S.emitEvent(r.id, "pull_request.archived", actor, { number });
    });
    return { ok: true } as const;
  },

  unarchive(name: string, number: number, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const pull = S.getPull(row.id)!;
    if (row.state === "open" && !pull.merged && pull.linked_issue_id != null) {
      const linkedIssue = S.getIssueById(pull.linked_issue_id)!;
      assertNoOtherOpenPull(linkedIssue.id, linkedIssue.number, row.id);
    }
    const actor = actorFor(sessionId);
    db.transaction(() => {
      S.unarchivePull(row.id);
      S.emitEvent(r.id, "pull_request.unarchived", actor, { number });
    });
    return { ok: true } as const;
  },

  async files(name: string, number: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const p = S.getPull(row.id)!;
    return diffFiles(r.local_path, p.base_ref, p.head_ref);
  },

  async diff(
    name: string,
    number: number,
    path?: string,
    ignoreWhitespace = false,
  ) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const p = S.getPull(row.id)!;
    const projectRoot =
      existingPullWorktreePath({
        fullName: r.full_name,
        headRef: p.head_ref,
        prNumber: row.number,
      }) ?? r.local_path;
    const [baseSha, headSha] = await Promise.all([
      resolvePullBaseSha(r.local_path, p),
      revParse(r.local_path, p.head_ref),
    ]);
    if (!baseSha || !headSha)
      throw new ServiceError(422, "pull request diff is unavailable");
    const files = await diffFilesBetween(r.local_path, baseSha, headSha, {
      ignoreWhitespace,
    });
    const selectedFiles =
      path == null
        ? files
        : files.filter(
            (file) =>
              (file.headFilename ?? file.filename) === path ||
              file.previousFilename === path ||
              file.filename === path,
          );
    return {
      base_sha: baseSha,
      head_sha: headSha,
      files: selectedFiles.map((file) => {
        const serializedFile = {
          path: file.headFilename ?? file.filename,
          absolute_path: join(projectRoot, file.headFilename ?? file.filename),
          original_path: file.previousFilename ?? null,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch,
        };
        return {
          ...serializedFile,
          lines: parsePatchWithCoordinates(file.patch).map((line) => ({
            kind: line.kind,
            text: line.text,
            left_line: line.leftLine,
            right_line: line.rightLine,
          })),
        };
      }),
    };
  },

  async commitFiles(name: string, number: number, sha: string) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const p = S.getPull(row.id)!;
    if (!(await commitInRange(r.local_path, p.base_ref, p.head_ref, sha))) {
      throw new ServiceError(404, "Not Found");
    }
    return commitDiffFiles(r.local_path, sha);
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
    // renders it as a GitHub-branded link (the PR-detail sidebar's GitHub PR heading), so accepting
    // an arbitrary host would let a caller plant a misleading link. The scheme check also keeps
    // javascript:/data: out.
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
    return db.transaction(() => {
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
    });
  },

  // #2384: drop the GitHub PR link recorded on a loophub PR. The inverse of recordGithubPull, for a
  // link that points at the wrong PR or at a GitHub PR that no longer exists — with the link gone,
  // `github_pull` is null again and the PR-detail action row offers "Create PR on GitHub" once more.
  // Only the LoopHub-side link is removed; nothing is done to the GitHub PR itself. 409 when there is
  // no link, so an accidental double-submit reads as an error rather than silently succeeding.
  unlinkGithubPull(name: string, number: number, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const link = S.getGithubPull(row.id);
    if (!link)
      throw new ServiceError(409, `PR #${number} has no GitHub PR to unlink`);
    const actor = actorFor(sessionId);
    return db.transaction(() => {
      S.deleteGithubPull(row.id);
      S.emitEvent(r.id, "pull_request.github_pr_unlinked", actor, {
        number: row.number,
        github_number: link.number,
        url: link.url,
      });
      return { unlinked: true as const, github_number: link.number };
    });
  },

  // #411: orchestrate submitting a loophub PR to GitHub as a Draft PR in one place — push the head
  // branch under a content-based name, open (or recover) a GitHub Draft PR, and record it back.
  // The "Create PR on GitHub" export prompt (github-pr-export-prompt.ts) only generates
  // branch/title/body (LLM work) and calls this, instead of chaining cd → git push → gh pr create →
  // record itself (AGENTS.md: git+DB+destructive orchestration belongs in core). Atomicity: if
  // recording fails after `gh` creates the PR, a
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
    // #848: remember which head SHA we just pushed, so the UI can later tell when local commits added
    // after this export have not yet reached the GitHub branch (head resolves — the push above needed
    // it — but tolerate a null defensively rather than throw after the PR is already created). Read it
    // before the DB phase so the push, `gh` and this git read all stay outside the transaction.
    const pushedSha = await revParse(repoPath, head);
    return db.transaction(() => {
      S.recordGithubPull({
        issueId: row.id,
        number: gh.number,
        url: trimmedUrl,
        branch,
        createdBy: actor,
      });
      const rec = pushedSha
        ? S.setGithubPushed(row.id, pushedSha)
        : S.getGithubPull(row.id)!;
      S.emitEvent(r.id, "pull_request.github_pr_recorded", actor, {
        number: row.number,
        github_number: gh.number,
        url: rec.url,
      });
      return githubPullJSON(rec);
    });
  },

  // #848: push the loophub PR's current head to the branch of its already-recorded GitHub PR, so
  // commits added locally after the export reach GitHub without re-creating the PR. Mirrors
  // createGithubPull's push (same `pushBranch` refspec, same GitHub-origin requirement), but requires
  // an existing link and reuses its stored branch instead of taking a new one. Records the pushed head
  // SHA (pushed_sha) so the button that offers this action hides once GitHub is up to date. git push +
  // the DB update live here in core (AGENTS.md); `deps` is injectable so this is unit-testable.
  // `input.force` (#1861) force-pushes (`--force-with-lease`) for a head rewritten by rebase/amend,
  // which a plain push rejects. It only changes the push itself — every guard below still applies.
  async pushGithubPull(
    name: string,
    number: number,
    input: { force?: boolean } = {},
    sessionId?: string | null,
    deps: GithubDeps = realGithubDeps,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");

    const gh = S.getGithubPull(row.id);
    if (!gh)
      throw new ServiceError(409, `PR #${number} has no GitHub PR to push to`);
    if (!gh.branch)
      throw new ServiceError(
        422,
        "the recorded GitHub PR has no branch to push to",
      );
    // Defense-in-depth: re-validate the stored branch with the same charset guard createGithubPull
    // applies before pushing. createGithubPull already rejects injection-prone names, but a branch
    // recorded via record-github-pr (#487) is stored unvalidated — re-check here so a crafted value
    // can never reach `git push` as a flag/refspec (pushBranch's `refs/heads/` prefix already anchors
    // it, so this is belt-and-suspenders, not the sole defense).
    if (
      gh.branch.startsWith("-") ||
      gh.branch.includes("..") ||
      !/^[A-Za-z0-9._/-]+$/.test(gh.branch)
    )
      throw new ServiceError(
        422,
        "the recorded GitHub branch has invalid characters",
      );

    const p = S.getPull(row.id)!;
    // Only push while the loophub PR is genuinely open — a merged/closed PR is past the point of
    // syncing more commits. The UI hides the button in these states, but guard here too so a direct
    // RPC can't push onto the GitHub branch of a PR that's already done.
    if (p.merged || row.state !== "open")
      throw new ServiceError(405, "Pull Request is not open");

    // Require a GitHub origin so the push targets GitHub (mirrors createGithubPull).
    if (!isGithubRemoteUrl(await remoteUrl(r.local_path)))
      throw new ServiceError(422, "repo has no GitHub origin remote");

    // Run from the main checkout, not the worktree (shared refs, origin lives here, worktree may be
    // pruned) — the same location resolution createGithubPull uses.
    const repoPath = r.local_path;
    const head = p.head_ref;
    const force = input.force === true;

    try {
      await deps.push(repoPath, head, gh.branch, { force });
    } catch (e) {
      throw new ServiceError(
        502,
        `failed to ${force ? "force-push" : "push"} branch: ${(e as Error).message}`,
      );
    }

    const actor = actorFor(sessionId);
    const pushedSha = await revParse(repoPath, head);
    return db.transaction(() => {
      const rec = pushedSha ? S.setGithubPushed(row.id, pushedSha) : gh;
      S.emitEvent(r.id, "pull_request.github_pr_pushed", actor, {
        number: row.number,
        github_number: gh.number,
        sha: pushedSha,
        force,
      });
      return githubPullJSON(rec);
    });
  },

  async merge(
    name: string,
    number: number,
    method: PullMergeMethod,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const p = S.getPull(row.id)!;
    if (p.merged) throw new ServiceError(405, "Pull Request is already merged");
    if (row.state !== "open")
      throw new ServiceError(405, "Pull Request is not open");
    // A diff-free PR has nothing to merge — the UI disables the Merge button for this
    // state (#691), but merge-tree itself does not reject it (a diff-free tree merges
    // cleanly), so this check must be enforced here too. Use base...head effective diff,
    // not the two-dot commit count: a PR can have commits ahead of base whose net changes
    // cancel out and still be empty to merge (#1243). Only run it when both refs actually
    // resolve (mirroring serialize.ts's headSha/baseSha guard) — an unresolvable ref isn't
    // "no commits", it's a broken branch, and should fall through to gitMergePull's own
    // "Merge failed" below rather than report a misleading reason.
    const [headSha, baseSha] = await Promise.all([
      revParse(r.local_path, p.head_ref),
      revParse(r.local_path, p.base_ref),
    ]);
    if (headSha && baseSha) {
      if (!(await hasEffectiveDiff(r.local_path, p.base_ref, p.head_ref)))
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
      // Events stay attributed to `actor`; the commit itself takes the merging agent's name only
      // when one exists, so a human merge is authored by the repository's git config user.
      gitActorFor(sessionId),
    );
    if (res.conflict) {
      S.emitEvent(r.id, "pull_request.merge_conflict", actor, {
        number: row.number,
        source_payload_version: SOURCE_PAYLOAD_VERSION,
      });
      throw new ServiceError(409, "Merge conflict");
    }
    if (!res.merged) throw new ServiceError(422, "Merge failed");
    // The git merge is done; the PR state, persisted facts and every subscriber write commit
    // together so a merged PR is never recorded without the closure cascade it caused.
    db.transaction(() => {
      S.setMerged(row.id, res.sha!, method);
      publish({
        type: "pull.closed",
        repoId: r.id,
        actor,
        pullId: row.id,
        pullNumber: row.number,
        linkedIssueId: p.linked_issue_id,
        reason: { kind: "merged", sha: res.sha!, method },
      });
    });
    return { merged: true, sha: res.sha };
  },

  markGithubMerged(name: string, number: number, sessionId?: string | null) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const pull = S.getPull(row.id)!;
    if (pull.merged)
      throw new ServiceError(405, "Pull Request is already merged");
    if (row.state !== "open")
      throw new ServiceError(405, "Pull Request is not open");
    const githubPull = S.getGithubPull(row.id);
    if (!githubPull?.github_merged || !githubPull.github_merged_at) {
      throw new ServiceError(405, "GitHub merge has not been detected");
    }

    const actor = actorFor(sessionId);
    db.transaction(() => {
      S.setMergedFromGithub(row.id, githubPull.github_merged_at!);
      publish({
        type: "pull.closed",
        repoId: r.id,
        actor,
        pullId: row.id,
        pullNumber: row.number,
        linkedIssueId: pull.linked_issue_id,
        reason: {
          kind: "github_merged",
          githubNumber: githubPull.number,
          mergedAt: githubPull.github_merged_at!,
        },
      });
    });
    return { merged: true, merged_at: githubPull.github_merged_at };
  },

  // #850: the GitHub-side status (draft / review / checks / comment counts / merged) of a PR's linked
  // GitHub PR, for the PR-detail right sidebar. Fetched on demand via `gh` and cached in
  // github_pull_status with a short TTL — a cache hit within the TTL skips `gh`. On a `gh` failure a
  // still-usable stale cache is returned rather than erroring (the UI surfaces `synced_at`); only a
  // failure with no cache at all becomes a 502, which drives the sidebar's "fetch failed" state.
  // `deps` is injectable so this is unit-testable without a GitHub remote. Throws 404 when the PR has
  // no linked GitHub PR — the UI only calls this once `github_pull` is present.
  async githubStatus(
    name: string,
    number: number,
    deps: GithubPrStatusDeps = realGithubPrStatusDeps,
  ) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const link = S.getGithubPull(row.id);
    if (!link) throw new ServiceError(404, "PR has no linked GitHub PR");

    const cached = S.getGithubPullStatus(row.id);
    if (
      cached &&
      Date.now() - Date.parse(cached.synced_at) < GITHUB_PR_STATUS_TTL_MS
    ) {
      return githubPrStatusJSON(
        parseGhPrStatus(cached.payload),
        cached.synced_at,
      );
    }

    let status: Awaited<ReturnType<GithubPrStatusDeps["fetchStatus"]>>;
    try {
      status = await deps.fetchStatus(r.local_path, link.url);
    } catch (e) {
      if (cached)
        return githubPrStatusJSON(
          parseGhPrStatus(cached.payload),
          cached.synced_at,
        );
      throw new ServiceError(
        502,
        `failed to fetch GitHub PR status: ${(e as Error).message}`,
      );
    }
    const saved = S.saveGithubPullStatus(row.id, JSON.stringify(status));
    return githubPrStatusJSON(status, saved.synced_at);
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
      review_responses: S.listReviewResponses(issueRow.id),
      comments: S.listComments(issueRow.id),
      events,
      session: sessionRow ? agentSessionJSON(sessionRow) : null,
    };
  },
};
