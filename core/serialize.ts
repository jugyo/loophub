// JSON serializers: shape store rows into the stable wire objects that consumers
// (CLI now, JSON-RPC clients later) read. Kept separate from service.ts so the
// shaping is reusable and side-effect free.

import { worktreeRoot } from "./config.ts";
import { conflictsForPull, type PullConflict } from "./conflicts.ts";
import { commitsAhead, diffStat, mergePreview, revParse } from "./git.ts";
import { linkedRef } from "./links.ts";
import { resolveMergeable } from "./mergeable.ts";
import { pullWorktreeDirty } from "./pull-worktree.ts";
import {
  resolveRuntimeResume,
  resumeWorktreeIssue,
  sessionRuntime,
} from "./resume.ts";
import * as S from "./store.ts";
import { worktreePath } from "./worktree-path.ts";

export function repoJSON(r: S.Repo) {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    owner: { login: r.owner },
    default_branch: r.default_branch,
    local_path: r.local_path,
    created_at: r.created_at,
    archived: !!r.archived,
    archived_at: r.archived_at ?? null,
  };
}

export function agentSessionJSON(row: any) {
  const out: any = {
    id: row.id,
    agent: row.agent,
    session: row.external_session,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.name) out.name = row.name;
  if (row.runtime) out.runtime = row.runtime;
  if (row.kind) out.kind = row.kind;
  return out;
}

// One entry in a PR/issue's "related sessions" list (#298). Wraps agentSessionJSON with `linked_at`
// (when the session was attached to this target) and a `resume` verdict that follows core/resume.ts'
// runtime-based judgment:
//   - resumable=true  → `lh resume <pr>` would re-enter this session (claude-code + UUID id, and it
//     is the PR's current primary attribution).
//   - resumable=false → `reason` says why: a runtime this build cannot resume ("unknown-runtime"),
//     nothing resumable on the row ("no-session"), an issue-linked session that is resumed via its
//     PR rather than the issue ("resume-via-pull"), a past dev session a newer one replaced as the
//     PR's anchor ("superseded"), or a session that is simply not the PR's resume anchor — a non-dev
//     session, or any session on a PR with no anchor at all ("not-anchor"). resume is intentionally
//     runtime-level only — it reflects whether the runtime + anchor make `lh resume <pr>` meaningful,
//     not whether the worktree/branch still survive on disk.
//
// `lh resume <pr>` re-enters exactly the PR's primary dev session (pulls.session_id = primarySessionId).
// So a row is resumable ONLY when it IS that anchor; everything else is reported with a reason. The
// anchor check must compare equality directly (not "anchor exists AND not this row"), otherwise a PR
// with no anchor at all (primarySessionId null — reachable by linking a session via `sessions.link`
// to a PR that never had a dev session) would fall through and be mislabeled resumable.
export function relatedSessionJSON(
  row: any,
  opts: { container: "issue" | "pull"; primarySessionId?: string | null },
): any {
  const base = agentSessionJSON(row);
  const rr = resolveRuntimeResume(sessionRuntime(row), row.external_session);
  let resume: { resumable: boolean; reason?: string };
  if (!rr.ok) {
    resume = { resumable: false, reason: rr.reason };
  } else if (opts.container !== "pull") {
    resume = { resumable: false, reason: "resume-via-pull" };
  } else if (opts.primarySessionId && row.id === opts.primarySessionId) {
    resume = { resumable: true };
  } else if (opts.primarySessionId && row.kind === "dev") {
    // A dev session on this PR that a newer dev session replaced as the resume anchor.
    resume = { resumable: false, reason: "superseded" };
  } else {
    // Runtime-resumable but not the PR's anchor: a non-dev session linked to the PR, or a PR with
    // no anchor at all (pulls.session_id null). `lh resume <pr>` has nothing of this row to re-enter.
    resume = { resumable: false, reason: "not-anchor" };
  }
  return { ...base, linked_at: row.linked_at ?? null, resume };
}

// The full related-sessions list for an issues row (issue or PR), newest link first. `primarySessionId`
// is the PR's pulls.session_id — the one `lh resume <pr>` actually re-enters — so only that row is
// marked directly resumable; pass it for PR containers, omit it for issue containers.
export function relatedSessionsJSON(
  containerRow: any,
  opts: { primarySessionId?: string | null } = {},
): any[] {
  const container = containerRow.kind === "pull" ? "pull" : "issue";
  return S.listSessionsForIssue(containerRow.id).map((row) =>
    relatedSessionJSON(row, {
      container,
      primarySessionId: opts.primarySessionId,
    }),
  );
}

export function commentJSON(m: any) {
  return {
    id: m.id,
    user: { login: m.author },
    body: m.body,
    created_at: m.created_at,
  };
}

export function reviewJSON(v: any) {
  return {
    id: v.id,
    user: { login: v.author },
    state: v.event,
    body: v.body,
    // The commit this review was made against (lets clients group reviews by
    // commit, e.g. #208) and its aspect/topic (#209). Both may be null.
    head_sha: v.head_sha ?? null,
    topic: v.topic ?? null,
    submitted_at: v.created_at,
  };
}

export function reviewCommentJSON(m: any) {
  return {
    id: m.id,
    pull_request_review_id: m.review_id,
    user: { login: m.author },
    path: m.path,
    line: m.line,
    side: m.side,
    body: m.body,
    created_at: m.created_at,
  };
}

// Shape a `review_notes` row (#204). pull_request summarizes the owning PR by number so
// consumers see the PR, not the internal row id. base_sha/commit_sha expose the diff range the
// note is about; a consumer compares commit_sha against the PR's live head to decide staleness.
export function reviewNoteJSON(n: any) {
  const prRow = S.getIssueById(n.issue_id);
  return {
    id: n.id,
    pull_request: prRow ? { number: prRow.number } : null,
    path: n.path,
    base_sha: n.base_sha,
    commit_sha: n.commit_sha,
    body: n.body,
    user: { login: n.author },
    created_at: n.created_at,
    updated_at: n.updated_at,
  };
}

export function labelJSON(l: any) {
  return { name: l.name, color: l.color };
}

function linkedIssueSummary(repo: S.Repo, pullRowId: number) {
  const p = S.getPull(pullRowId);
  if (!p?.linked_issue_id) return null;
  const linked = S.getIssueById(p.linked_issue_id);
  if (linked?.kind !== "issue") return null;
  return {
    number: linked.number,
    title: linked.title,
    state: linked.state,
    html_url: linkedRef(repo, "issues", linked.number).html_url,
  };
}

function linkedPullSummary(repo: S.Repo, issueRowId: number) {
  const pr = S.linkedPullForIssue(issueRowId);
  if (!pr) return null;
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: !!pr.merged,
    html_url: linkedRef(repo, "pulls", pr.number).html_url,
  };
}

// Git-derived status fields for a PR row: mergeable state, diff totals, the
// "working" flag, and review state. Shared by pullJSON (PR list/detail) and the
// issue list's linked-PR summary so both compute status identically. The git
// fan-out (revParse/mergePreview/diffStat/status) is bounded — callers keep
// their lists paginated.
async function pullStatusFields(
  repo: S.Repo,
  row: any,
  opts: {
    withConflicts?: boolean;
    headShaCache?: Map<string, Promise<string | null>>;
  } = {},
) {
  const p = S.getPull(row.id);
  const headSha = await revParse(repo.local_path, p.head_ref);
  const baseSha = await revParse(repo.local_path, p.base_ref);
  const review_state = S.computeReviewState(row.id);
  let mergeable: boolean | null = null;
  let mergeable_state = "unknown";
  // Whether this PR carries any commits over its base (diff-free when 0). Reused
  // by the cross-PR conflict guard below so a diff-free PR — which can never
  // conflict (see core/mergeable.ts) — skips the conflict fan-out entirely.
  let hasCommits = false;
  if (!p.merged && headSha && baseSha) {
    const [prev, ahead] = await Promise.all([
      mergePreview(repo.local_path, p.base_ref, p.head_ref),
      commitsAhead(repo.local_path, p.base_ref, p.head_ref),
    ]);
    hasCommits = ahead > 0;
    ({ mergeable, mergeable_state } = resolveMergeable({
      hasCommits,
      conflict: prev.conflict,
      approved: review_state === "APPROVED",
    }));
  }
  // Diff totals (+/-, changed files) for the PR. Aggregated from numstat over
  // base...head; left at 0 when refs can't be resolved so list/detail render
  // gracefully. Skip merged PRs (like the mergeable fan-out above): base...head
  // would be empty for a merge commit but show the full original diff for a
  // squash/rebase merge whose head branch still exists — inconsistent, so don't.
  let additions = 0;
  let deletions = 0;
  let changed_files = 0;
  if (!p.merged && headSha && baseSha) {
    try {
      ({
        additions,
        deletions,
        changedFiles: changed_files,
      } = await diffStat(repo.local_path, p.base_ref, p.head_ref));
    } catch {
      // leave zeros — a diff stat failure must not break serialization
    }
  }
  // "working" badge: real uncommitted changes in this PR's lh-dev worktree. Guarded so the
  // git status only runs for an open PR whose worktree directory actually exists (see
  // pullWorktreeDirty); merged/closed and worktree-less PRs skip git.
  const linked = linkedIssueSummary(repo, row.id);
  const working = await pullWorktreeDirty({
    fullName: repo.full_name,
    headRef: p.head_ref,
    linkedIssueNumber: linked?.number ?? null,
    prNumber: row.number,
    merged: !!p.merged,
    state: row.state,
  });
  // Cross-PR conflicts: only on demand (PR detail), and only for an open, unmerged
  // PR with a resolvable head — the PR list skips this to keep its fan-out O(n).
  // A diff-free PR (hasCommits === false) can never conflict, so skip the fan-out
  // and leave conflicts_with empty — same principle resolveMergeable applies above.
  let conflicts_with: PullConflict[] = [];
  if (
    opts.withConflicts &&
    !p.merged &&
    row.state === "open" &&
    headSha &&
    hasCommits
  ) {
    conflicts_with = await conflictsForPull(
      repo,
      row.number,
      headSha,
      opts.headShaCache,
    );
  }
  // Deterministic path of the `lh dev` worktree backing this PR (same convention as the
  // "working" flag above), so a consumer can show / copy it without knowing worktreeRoot.
  // Pure path math (no fs); null only for a crafted repo name that can't form a safe path.
  let worktree_path: string | null = null;
  try {
    const issue = resumeWorktreeIssue(
      p.head_ref,
      linked?.number ?? null,
      row.number,
    );
    worktree_path = worktreePath(worktreeRoot(), repo.full_name, issue);
  } catch {
    worktree_path = null;
  }
  return {
    headSha,
    baseSha,
    mergeable,
    mergeable_state,
    additions,
    deletions,
    changed_files,
    working,
    review_state,
    linked,
    conflicts_with,
    worktree_path,
  };
}

// Issue list item with its linked PR enriched with status (working / review /
// mergeable / diff totals) for the issue-list Pattern E sub-row. Async because
// the status fields need a bounded git fan-out per linked PR; used only by the
// paginated issues.list path, so issueJSON stays sync for detail/dashboard.
// `headShaCache` (optional) is a per-list-build cache the caller passes once and
// shares across every row's linked-PR enrichment, so the cross-PR conflict fan-out
// rev-parses each open PR's head ref at most once for the whole page (see
// core/conflicts.ts resolveHeadSha). Omit it for a single-row serialization.
export async function issueListItemJSON(
  row: any,
  repo: S.Repo,
  headShaCache?: Map<string, Promise<string | null>>,
) {
  const out = issueJSON(row, repo);
  if (row.kind !== "pull") {
    // All linked PRs (usually 0–1, occasionally more — see linkedPullsForIssue),
    // most-relevant first, so the list can stack them vertically. The singular
    // field stays set to the primary one for any consumer that reads it.
    const pulls = await Promise.all(
      S.linkedPullsForIssue(row.id).map((pr) =>
        linkedPullDetail(repo, pr, headShaCache),
      ),
    );
    out.linked_pull_requests = pulls;
    out.linked_pull_request = pulls[0] ?? null;
  }
  return out;
}

async function linkedPullDetail(
  repo: S.Repo,
  pr: any,
  headShaCache?: Map<string, Promise<string | null>>,
) {
  // `withConflicts` so the issue-list sub-row can flag a PR that merge-conflicts
  // with another open PR (#267), matching the PR-detail ConflictList. The PR list
  // skips this to stay O(n); here the cost is bounded by the per-pair merge-result
  // memo (immutable sha pairs, process-lifetime) plus the per-build headShaCache
  // (ref→sha resolved once per open PR per page), and only open, unmerged linked
  // PRs — usually 0–1 per issue — trigger it at all.
  const status = await pullStatusFields(repo, pr, {
    withConflicts: true,
    headShaCache,
  });
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
    conflicts_with: status.conflicts_with,
  };
}

export function issueJSON(row: any, repo?: S.Repo) {
  const out: any = {
    number: row.number,
    state: row.state,
    title: row.title,
    body: row.body,
    user: { login: row.author },
    labels: S.issueLabels(row.id).map(labelJSON),
    comments: S.countComments(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.kind === "pull") out.pull_request = { url: `/pulls/${row.number}` };
  else if (repo) out.linked_pull_request = linkedPullSummary(repo, row.id);
  return out;
}

function safeParseArray(json: string | null | undefined): any[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Shape a `retros` row into the wire object the CLI (and later JSON-RPC) reads.
// pr / issue are summarized from their issues rows so consumers see numbers, not
// internal row ids. rubric / findings are parsed back from their JSON columns.
export function retroJSON(row: any) {
  const prRow = row.pr_id != null ? S.getIssueById(row.pr_id) : null;
  const issueRow = row.issue_id != null ? S.getIssueById(row.issue_id) : null;
  return {
    id: row.id,
    pr: prRow ? { number: prRow.number, title: prRow.title } : null,
    issue: issueRow ? { number: issueRow.number, title: issueRow.title } : null,
    session_id: row.session_id ?? null,
    rubric: safeParseArray(row.rubric_json),
    findings: safeParseArray(row.findings_json),
    status: row.status,
    reviewed_by: row.reviewed_by ?? null,
    redacted: !!row.redacted,
    redact_ruleset: row.redact_ruleset ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// `withConflicts` triggers the cross-PR conflict fan-out (PR head vs every other
// open PR's head). Enabled for the PR *detail* (pulls.get) only; the PR *list* and
// dashboard leave it off so their per-row serialization stays O(1) git calls.
export async function pullJSON(
  repo: S.Repo,
  row: any,
  opts: { withConflicts?: boolean; withRelatedSessions?: boolean } = {},
) {
  const p = S.getPull(row.id);
  const status = await pullStatusFields(repo, row, {
    withConflicts: opts.withConflicts,
  });

  return {
    number: row.number,
    state: row.state,
    title: row.title,
    body: row.body,
    user: { login: row.author },
    head: { ref: p.head_ref, sha: status.headSha },
    base: { ref: p.base_ref, sha: status.baseSha },
    merged: !!p.merged,
    mergeable: status.mergeable,
    mergeable_state: status.mergeable_state,
    merge_commit_sha: p.merge_commit_sha,
    additions: status.additions,
    deletions: status.deletions,
    changed_files: status.changed_files,
    working: status.working,
    review_state: status.review_state,
    changes_addressed_at: p.changes_addressed_at ?? null,
    changes_addressed_by: p.changes_addressed_by ?? null,
    labels: S.issueLabels(row.id).map(labelJSON),
    comments: S.countComments(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    linked_issue: status.linked,
    conflicts_with: status.conflicts_with,
    worktree_path: status.worktree_path,
    // Detail-only (#298): the PR's related sessions, newest first, with per-row resume verdicts.
    // Gated like withConflicts so the PR list/dashboard stay O(1) git + no extra per-row query.
    ...(opts.withRelatedSessions
      ? {
          related_sessions: relatedSessionsJSON(row, {
            primarySessionId: p.session_id ?? null,
          }),
        }
      : {}),
  };
}
