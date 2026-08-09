// Status-enriched serializers: the wire objects whose values are derived from live git and
// worktree state, not from a store row alone. Kept out of serialize.ts so the row -> wire
// converters there stay synchronous and pure (no node:fs, no core/git.ts) and can be unit-tested
// without a git repo. The wire types these return are still defined in serialize.ts, which stays
// the wire-shape SSOT (AGENTS.md "Wire types (core vs web)").

import {
  commitLog,
  commitsAhead,
  localBranchRef,
  pushedCommitShas,
  remoteUrl,
  revParse,
} from "./git.ts";
import { linkedRef } from "./links.ts";
import type { MergeMode } from "./merge-mode.ts";
import { effectiveMergeMode, isGithubRemoteUrl } from "./merge-mode.ts";
import type { MergeableState } from "./mergeable.ts";
import { resolveMergeable } from "./mergeable.ts";
import { resolvePullBaseSha, resolvePullDiffBaseSha } from "./pull-base.ts";
import { pullShaStatus } from "./pull-status-cache.ts";
import {
  existingPullWorktreePath,
  pullWorktreeDirty,
} from "./pull-worktree.ts";
import type {
  GithubPullWire,
  IssueListPullSummaryWire,
  IssueWire,
  LinkedIssueWire,
  PullWire,
  ReviewGateWire,
} from "./serialize.ts";
import {
  commentJSON,
  githubPullJSON,
  herdrPaneJSON,
  issueJSON,
  labelJSON,
  linkedIssueSummary,
  pullWorkDuration,
  relatedSessionsJSON,
  relatedSessionsUsageJSON,
  reviewGateJSON,
} from "./serialize.ts";
import { sessionRuntime } from "./session-runtime.ts";
import * as S from "./store.ts";

// Git-derived status fields for a PR row: mergeable state, diff totals, the
// "working" flag, and review state. Shared by pullJSON (PR list/detail) and the
// issue list's linked-PR summary so both compute status identically. The git
// fan-out (revParse/mergePreview/diffStat/status) is bounded — callers keep
// their lists paginated — and its SHA-derived slice (merge preview, commits
// ahead, effective diff, diff stat) is cached on the (baseSha, headSha) pair so
// a list refetch with no moved ref reuses the result instead of respawning git
// (#1668, see pull-status-cache.ts). "working" and review state are not
// SHA-determined and are recomputed every call.
interface PullStatusFields {
  // The PR row this status was computed from — already fetched here, so callers reuse it instead of
  // a second S.getPull for the same id (e.g. linkedPullDetail's #882 work-duration lookup).
  pull: S.PullRow;
  headSha: string | null;
  baseSha: string | null;
  forkBaseSha: string | null;
  mergeable: boolean | null;
  mergeable_state: MergeableState;
  additions: number;
  deletions: number;
  changed_files: number;
  // Commits head is ahead of base by (0 when merged / refs unresolvable). Already computed for the
  // mergeable gate below; surfaced here so linkedPullDetail can hide Diff/Review on empty attempts.
  commits_ahead: number;
  working: boolean;
  review_state: S.ReviewState;
  review_gate: ReviewGateWire;
  linked: LinkedIssueWire | null;
  worktree_path: string | null;
}

async function pullStatusFields(
  repo: S.Repo,
  row: S.IssueRow,
): Promise<PullStatusFields> {
  const p = S.getPull(row.id)!;
  const [headSha, baseSha, forkBaseSha] = await Promise.all([
    revParse(repo.local_path, localBranchRef(p.head_ref)),
    revParse(repo.local_path, localBranchRef(p.base_ref)),
    resolvePullBaseSha(repo.local_path, p),
  ]);
  // Prefer the live Git head for both display state and merge gate. The stored
  // watcher SHA is only a fallback when the ref cannot currently be resolved.
  // computeReviewStatus resolves the gate once so these two signals cannot
  // disagree about a stale or changes-requested review.
  const reviewStatus = S.computeReviewStatus(row.id, headSha ?? p.head_sha);
  let mergeable: boolean | null = null;
  let mergeable_state: MergeableState = "unknown";
  let commits_ahead = 0;
  // Diff totals (+/-, changed files) for the PR. Left at 0 when refs can't be
  // resolved so list/detail render gracefully. Skip merged PRs: base...head
  // would be empty for a merge commit but show the full original diff for a
  // squash/rebase merge whose head branch still exists — inconsistent, so don't.
  let additions = 0;
  let deletions = 0;
  let changed_files = 0;
  if (!p.merged && headSha && baseSha) {
    // #1668: the merge preview, commits-ahead, effective-diff, and diff stat
    // are all deterministic in (baseSha, headSha), so the whole fan-out is
    // cached on that pair — a refetch with no moved ref spawns zero git
    // subprocesses. Asking for the resolved SHAs (not the refs) is what makes
    // the value match its key even if a ref moves after we resolved it.
    const status = await pullShaStatus(repo.local_path, baseSha, headSha);
    commits_ahead = status.commitsAhead;
    additions = status.additions;
    deletions = status.deletions;
    changed_files = status.changedFiles;
    ({ mergeable, mergeable_state } = resolveMergeable({
      hasEffectiveDiff: status.hasEffectiveDiff,
      conflict: status.conflict,
      reviewGate: reviewStatus.gate,
    }));
  }
  // "working" badge: real uncommitted changes in this PR's worktree. Guarded so the
  // git status only runs for an open PR whose worktree directory actually exists (see
  // pullWorktreeDirty); merged/closed and worktree-less PRs skip git.
  const linked = linkedIssueSummary(repo, row.id);
  const working = await pullWorktreeDirty({
    fullName: repo.full_name,
    headRef: p.head_ref,
    prNumber: row.number,
    merged: !!p.merged,
    state: row.state,
  });
  // Path of the existing PR worktree (same convention as the "working" flag above), so a
  // consumer can show / copy it without knowing worktreeRoot. Null when the path is unsafe or
  // the worktree directory has not been provisioned / was removed.
  const worktree_path = existingPullWorktreePath({
    fullName: repo.full_name,
    headRef: p.head_ref,
    prNumber: row.number,
  });
  return {
    pull: p,
    headSha,
    baseSha,
    forkBaseSha,
    mergeable,
    mergeable_state,
    additions,
    deletions,
    changed_files,
    commits_ahead,
    working,
    review_state: reviewStatus.state,
    review_gate: reviewGateJSON(reviewStatus.gate),
    linked,
    worktree_path,
  };
}

// #406: the PR's effective write action ('merge' | 'github_pr') and the exported GitHub PR (if any).
// Kept out of pullStatusFields (shared by the PR list and the issue-list linked-PR summary, neither
// of which renders the action) so only pullJSON pays for it. The GitHub-remote check is a repo-level
// constant resolved here once per PR detail, instead of being spent — and discarded — by every
// linked-PR summary row.
interface PullMergeFields {
  merge_mode: MergeMode;
  github_pull: GithubPullWire | null;
  github_pr_export_started_at: string | null;
}

async function pullMergeFields(
  repo: S.Repo,
  row: S.IssueRow,
): Promise<PullMergeFields> {
  const merge_mode = effectiveMergeMode(
    repo.merge_mode,
    isGithubRemoteUrl(await remoteUrl(repo.local_path)),
  );
  // #2383: both fields are projections of the one export record, so they cannot contradict each
  // other — a linked export reports its GitHub PR and no start; one still in flight reports its
  // start and no GitHub PR. How long a start still counts as in progress is the UI's question.
  const record = S.getGithubPrExport(row.id);
  return {
    merge_mode,
    github_pull: record?.status === "linked" ? githubPullJSON(record) : null,
    github_pr_export_started_at:
      record?.status === "creating" ? record.created_at : null,
  };
}

// Issue list item with its linked PR enriched with status (working / review /
// mergeable / diff totals) for the issue-list Pattern E sub-row. Async because
// the status fields need a bounded git fan-out per linked PR; used only by the
// paginated issues.list path, so issueJSON stays sync for detail/dashboard.
export async function issueListItemJSON(
  row: S.IssueRow,
  repo: S.Repo,
): Promise<IssueWire> {
  const out = issueJSON(row, repo);
  out.herdr_pane = herdrPaneJSON(S.getIssueHerdrPane(row.id));
  if (row.kind !== "pull") {
    // All linked PRs (usually 0–1, occasionally more — see linkedPullsForIssue),
    // most-relevant first, so the list can stack them vertically. The singular
    // field stays set to the primary one for any consumer that reads it.
    const pulls = await Promise.all(
      S.linkedPullsForIssue(row.id).map((pr) => linkedPullDetail(repo, pr)),
    );
    out.linked_pull_requests = pulls;
    out.linked_pull_request = pulls[0] ?? null;
  }
  return out;
}

export interface IssueListSelection {
  labelsByIssue: Map<number, S.LabelRow[]>;
  commentCountsByIssue: Map<number, number>;
  linkedPullsByIssue: Map<number, S.LinkedPullIssueRow[]>;
  herdrPanesByIssue: Map<number, S.IssueHerdrPane>;
}

export async function issueListItemsJSON(
  rows: S.IssueRow[],
  repo: S.Repo,
  selected: IssueListSelection,
): Promise<IssueWire[]> {
  const linkedPulls = rows.flatMap(
    (row) => selected.linkedPullsByIssue.get(row.id) ?? [],
  );
  const linkedDetails = await Promise.all(
    linkedPulls.map(
      async (pull) => [pull.id, await linkedPullDetail(repo, pull)] as const,
    ),
  );
  const detailByPull = new Map(linkedDetails);
  return rows.map((row) => {
    const out = issueJSON(row, undefined, {
      labels: selected.labelsByIssue.get(row.id) ?? [],
      comments: selected.commentCountsByIssue.get(row.id) ?? 0,
    });
    out.herdr_pane = herdrPaneJSON(
      selected.herdrPanesByIssue.get(row.id) ?? null,
    );
    const pulls = (selected.linkedPullsByIssue.get(row.id) ?? [])
      .map((pull) => detailByPull.get(pull.id))
      .filter((pull): pull is IssueListPullSummaryWire => pull !== undefined);
    out.linked_pull_requests = pulls;
    out.linked_pull_request = pulls[0] ?? null;
    out.has_open_pull_request = pulls.some((pull) => pull.state === "open");
    return out;
  });
}

async function linkedPullDetail(
  repo: S.Repo,
  pr: S.LinkedPullIssueRow,
): Promise<IssueListPullSummaryWire> {
  const status = await pullStatusFields(repo, pr);
  const usageTotals = S.sessionUsageTotalsForIssue(pr.id);
  const agent = S.pullAgentSummary(pr.id);
  const runtime = agent ? sessionRuntime(agent) : null;
  const model = agent?.models.length ? agent.models.join(", ") : null;
  // #882: total work duration for the sub-row, computed with the same pullWorkDuration used by the
  // PR-detail sidebar (#456). Reuses the PullRow status already fetched (no second S.getPull) plus one
  // primaryDevSessionForPull lookup, so per-row cost stays on par with #783's usage total and the list
  // stays bounded. Only `total` is surfaced here; phase breakdown stays detail-only.
  const workTotal = pullWorkDuration(
    repo,
    pr,
    status.pull,
    S.primaryDevSessionForPull(pr.id),
  ).total;
  const base_commits_behind =
    status.forkBaseSha && status.baseSha
      ? await commitsAhead(repo.local_path, status.forkBaseSha, status.baseSha)
      : 0;
  // #2147: the latest workflow run's rework count, so the issue list can show how many
  // Execute -> Verify loops the PR has taken. `workflow_runs` is indexed on (workflow_id, status)
  // only, so this scans the table — cheap against a table that holds one row per run and far below
  // the git fan-out this sub-row already pays. The list never asks Web to fetch run state per PR.
  const workflowRun = S.latestWorkflowRunForPull(repo.id, pr.number);
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: !!pr.merged,
    html_url: linkedRef(repo, "pulls", pr.number).html_url,
    working: status.working,
    review_state: status.review_state,
    mergeable_state: status.mergeable_state,
    additions: status.additions,
    deletions: status.deletions,
    changed_files: status.changed_files,
    commits_ahead: status.commits_ahead,
    base_commits_behind,
    ...(runtime ? { agent_runtime: runtime } : {}),
    ...(model ? { agent_model: model } : {}),
    // #629: the exported GitHub PR (if any), so the issue-list linked-PR sub-row can show a GH badge.
    github_pull: githubPullJSON(S.getGithubPull(pr.id)),
    // #863: whether this PR was force-stopped for exceeding its cost limit.
    cost_stopped: S.hasAnyCostStopEvent(repo.id, pr.number),
    // #2152: conversation comments plus diff-comment messages as one total, both counted in SQL.
    total_comments: S.countComments(pr.id) + S.countDiffFeedbackMessages(pr.id),
    // #783: agent cost (total tokens + cost) for the sub-row, or omitted when no linked session
    // has usage yet.
    ...(usageTotals
      ? {
          total_tokens: usageTotals.total_tokens,
          cost_usd: usageTotals.cost_usd,
        }
      : {}),
    // #882: total work duration, omitted when there is no dev session to anchor from.
    ...(workTotal && workTotal.seconds != null && workTotal.basis != null
      ? {
          work_duration_total: {
            seconds: workTotal.seconds,
            basis: workTotal.basis,
          },
        }
      : {}),
    // #2147: rework loops of the linked workflow run, omitted when the PR has no run.
    ...(workflowRun ? { workflow_rework_count: workflowRun.rework_count } : {}),
  };
}

export async function issueDetailJSON(
  row: S.IssueRow,
  repo: S.Repo,
): Promise<IssueWire> {
  const out = issueJSON(row, row.kind === "pull" ? repo : undefined);
  if (row.kind !== "pull") {
    const linked = S.allLinkedPullsForIssue(row.id);
    const archived = S.archivedLinkedPullsForIssue(row.id);
    // Detail shows every active linked PR, so each row needs the same status fields.
    // Archived history is selected separately below; list/dashboard paths remain capped.
    const pulls = await Promise.all(
      linked
        .slice(0, S.MAX_ISSUE_DETAIL_PULLS)
        .map((pr) => linkedPullDetail(repo, pr)),
    );
    out.linked_pull_requests = pulls;
    out.linked_pull_request = pulls[0] ?? null;
    out.has_open_pull_request = pulls.some((pull) => pull.state === "open");
    out.linked_pull_requests_truncated =
      linked.length > S.MAX_ISSUE_DETAIL_PULLS;
    out.archived_pull_requests = await Promise.all(
      archived
        .slice(0, S.MAX_ISSUE_DETAIL_PULLS)
        .map((pr) => linkedPullDetail(repo, pr)),
    );
    out.archived_pull_requests_truncated =
      archived.length > S.MAX_ISSUE_DETAIL_PULLS;
  }
  return out;
}

export async function pullJSON(
  repo: S.Repo,
  row: S.IssueRow,
  opts: {
    withCommits?: boolean;
    withRelatedSessions?: boolean;
    withComments?: boolean;
    /**
     * The PR's live diff base, when the caller has already resolved it. Resolving it costs a
     * `rev-parse`/`merge-base` fan-out that the git-command cache cannot serve (ref-name
     * operands), so a caller that needs the same base for something else — `pageData.pullDetail`,
     * which also diffs Files changed from it — passes its own instead of paying twice (#123).
     */
    diffBaseSha?: string;
  } = {},
): Promise<PullWire> {
  const p = S.getPull(row.id)!;
  const status = await pullStatusFields(repo, row);
  const mergeFields = await pullMergeFields(repo, row);
  const githubBaseSha =
    opts.withCommits && mergeFields.github_pull
      ? await revParse(repo.local_path, `refs/remotes/origin/${p.base_ref}`)
      : null;
  // #2444: list the commits from the same base the Files-changed diff uses, not the base branch
  // tip. `head --not <base tip>` re-lists the commits head forked from once the base branch is
  // rebased, because the rewrite makes them unreachable from that tip again. Resolved here rather
  // than in pullStatusFields so only PR detail (withCommits) pays for the extra git lookups.
  const commitBaseSha = opts.withCommits
    ? (opts.diffBaseSha ?? (await resolvePullDiffBaseSha(repo.local_path, p)))
    : null;
  const commits = opts.withCommits
    ? status.headSha && commitBaseSha
      ? await commitLog(
          repo.local_path,
          commitBaseSha,
          localBranchRef(p.head_ref),
          100,
          githubBaseSha ? [githubBaseSha] : [],
        )
      : []
    : undefined;
  const pushedShas =
    commits !== undefined &&
    status.headSha &&
    commitBaseSha &&
    mergeFields.github_pull?.pushed_sha
      ? await pushedCommitShas(
          repo.local_path,
          commitBaseSha,
          localBranchRef(p.head_ref),
          mergeFields.github_pull.pushed_sha,
        )
      : null;
  const commitsWithPushState =
    commits !== undefined && pushedShas
      ? commits.map((commit) => ({
          ...commit,
          pushed_to_github: pushedShas.has(commit.sha.toLowerCase()),
        }))
      : commits;
  const commentReactions = opts.withComments
    ? S.commentReactionsByIssue(row.id)
    : undefined;

  return {
    number: row.number,
    state: row.state,
    title: row.title,
    body: row.body,
    user: { login: row.author },
    head: { ref: p.head_ref, sha: status.headSha },
    base: { ref: p.base_ref, sha: status.baseSha },
    base_sha: status.forkBaseSha,
    merged: !!p.merged,
    mergeable: status.mergeable,
    mergeable_state: status.mergeable_state,
    merge_commit_sha: p.merge_commit_sha,
    additions: status.additions,
    deletions: status.deletions,
    changed_files: status.changed_files,
    working: status.working,
    review_state: status.review_state,
    review_gate: status.review_gate,
    changes_addressed_at: p.changes_addressed_at ?? null,
    changes_addressed_by: p.changes_addressed_by ?? null,
    archived_at: p.archived_at ?? null,
    labels: S.issueLabels(row.id).map(labelJSON),
    comments: S.countComments(row.id),
    ...(opts.withComments
      ? {
          comment_list: S.listComments(row.id).map((comment) =>
            commentJSON(comment, commentReactions?.get(comment.id) ?? []),
          ),
        }
      : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    linked_issue: status.linked,
    worktree_path: status.worktree_path,
    // #863: whether this PR was force-stopped for exceeding its cost limit.
    cost_stopped: S.hasAnyCostStopEvent(repo.id, row.number),
    // #406: the effective write action for this PR ('merge' | 'github_pr') and the GitHub PR it was
    // exported to (null until the export skill records one). The UI swaps Merge ⟷ Create/View PR.
    merge_mode: mergeFields.merge_mode,
    github_pull: mergeFields.github_pull,
    github_pr_export_started_at: mergeFields.github_pr_export_started_at,
    ...(commitsWithPushState !== undefined
      ? { commits: commitsWithPushState }
      : {}),
    // Detail-only (#298, #456): the PR's related sessions and derived work duration, newest first.
    // Gated so the PR list/dashboard stay O(1) git + no extra per-row query. Both share the same
    // primarySessionId lookup (primaryDevSessionForPull) is the implementation-session anchor used
    // by work duration.
    ...(opts.withRelatedSessions
      ? (() => {
          const primarySessionId = S.primaryDevSessionForPull(row.id);
          const relatedSessions = relatedSessionsJSON(row);
          return {
            related_sessions: relatedSessions,
            related_sessions_usage: relatedSessionsUsageJSON(relatedSessions),
            work_duration: pullWorkDuration(repo, row, p, primarySessionId),
          };
        })()
      : {}),
  };
}
