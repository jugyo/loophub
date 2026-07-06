// JSON serializers: shape store rows into the stable wire objects that consumers
// (CLI now, JSON-RPC clients later) read. Kept separate from service.ts so the
// shaping is reusable and side-effect free.

import { worktreeRoot } from "./config.ts";
import {
  commitParents,
  commitsAhead,
  diffStat,
  mergePreview,
  remoteUrl,
  revParse,
} from "./git.ts";
import { linkedRef } from "./links.ts";
import { assessMainMergeUndo } from "./main-merge-undo.ts";
import { effectiveMergeMode, isGithubRemoteUrl } from "./merge-mode.ts";
import { resolveMergeable } from "./mergeable.ts";
import { pullWorktreeDirty } from "./pull-worktree.ts";
import {
  resolveRuntimeResume,
  resolveWorktreeIdentity,
  SESSION_KIND_ISSUE_CREATE,
  sessionRuntime,
} from "./resume.ts";
import * as S from "./store.ts";
import { legacyWorktreePath, worktreePath } from "./worktree-path.ts";

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
    favorite: !!r.favorite,
    favorited_at: r.favorited_at ?? null,
    // #406: raw per-repo setting only ('merge' | 'github_pr' | null). The effective mode (which
    // resolves the null default against the GitHub remote) needs a git call, so it is served by the
    // dedicated repos/mergeMode procedure, not this sync serializer.
    merge_mode: r.merge_mode ?? null,
  };
}

// #406: shape a github_pulls row for the wire, or null. Keeps issue_id (an internal row id) off the
// wire — consumers identify the PR by its own number, and read the GitHub side via number/url. The
// overloads preserve non-nullness for callers (recordGithubPull) that always pass a real row.
export interface GithubPullWire {
  number: number;
  url: string;
  branch: string | null;
  created_by: string | null;
  created_at: string;
}
export function githubPullJSON(g: S.GithubPull): GithubPullWire;
export function githubPullJSON(g: S.GithubPull | null): GithubPullWire | null;
export function githubPullJSON(g: S.GithubPull | null): GithubPullWire | null {
  if (!g) return null;
  return {
    number: g.number,
    url: g.url,
    branch: g.branch ?? null,
    created_by: g.created_by ?? null,
    created_at: g.created_at,
  };
}

// #614: shape a github_issues row for the wire, or null. Keeps the internal issue_id off the wire —
// consumers read the GitHub side via owner/repo/number/url. Overloads preserve non-nullness for the
// import path, which always has a real row.
export interface GithubIssueWire {
  owner: string;
  repo: string;
  number: number;
  url: string;
  created_by: string | null;
  created_at: string;
}
export function githubIssueJSON(g: S.GithubIssue): GithubIssueWire;
export function githubIssueJSON(
  g: S.GithubIssue | null,
): GithubIssueWire | null;
export function githubIssueJSON(
  g: S.GithubIssue | null,
): GithubIssueWire | null {
  if (!g) return null;
  return {
    owner: g.owner,
    repo: g.repo,
    number: g.number,
    url: g.url,
    created_by: g.created_by ?? null,
    created_at: g.created_at,
  };
}

export function agentSessionJSON(
  row: any,
  opts: { withLinkedTargets?: boolean } = {},
) {
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
  const usage = S.listSessionUsage(row.id);
  if (usage.length) out.usage = usage.map(sessionUsageJSON);
  const subagentUsage = S.listSessionSubagentUsage(row.id);
  if (subagentUsage.length)
    out.subagent_usage = subagentUsage.map(sessionSubagentUsageJSON);
  if (opts.withLinkedTargets) {
    const linkedTargets = S.listSessionLinkedTargets(row.id);
    if (linkedTargets.length)
      out.linked_targets = linkedTargets.map(sessionLinkedTargetJSON);
  }
  return out;
}

export function sessionLinkedTargetJSON(row: any) {
  return {
    repo: row.repo,
    kind: row.kind,
    number: row.number,
    title: row.title,
    state: row.state,
  };
}

export function sessionUsageJSON(row: any) {
  return {
    session_id: row.session_id,
    model: row.model,
    input_tokens: row.input_tokens,
    cache_creation_input_tokens: row.cache_creation_input_tokens,
    cache_read_input_tokens: row.cache_read_input_tokens,
    output_tokens: row.output_tokens,
    cost_usd: row.cost_usd ?? null,
    updated_at: row.updated_at,
  };
}

export function sessionSubagentUsageJSON(row: any) {
  return {
    session_id: row.session_id,
    source_id: row.source_id,
    parent_source_id: row.parent_source_id ?? null,
    label: row.label ?? null,
    kind: row.kind,
    model: row.model,
    input_tokens: row.input_tokens,
    cache_creation_input_tokens: row.cache_creation_input_tokens,
    cache_read_input_tokens: row.cache_read_input_tokens,
    output_tokens: row.output_tokens,
    cost_usd: row.cost_usd ?? null,
    updated_at: row.updated_at,
  };
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
// `lh resume <pr>` re-enters exactly the PR's primary dev session (primaryDevSessionForPull =
// primarySessionId, #316). So a row is resumable ONLY when it IS that anchor; everything else is
// reported with a reason. The anchor check must compare equality directly (not "anchor exists AND
// not this row"), otherwise a PR with no anchor at all (primarySessionId null — reachable by linking
// a session via `sessions.link`
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
    // Issue container. An `issue-create` session (the New Issue AI flow, #299) has no PR and no dev
    // worktree, so it resumes directly off the issue with `claude --resume <id>` (resume by session
    // id, not by PR). Any other issue-linked session is a dev/review session whose resume anchor is
    // its PR, so it is still resumed via that PR ("resume-via-pull").
    resume =
      row.kind === SESSION_KIND_ISSUE_CREATE
        ? { resumable: true }
        : { resumable: false, reason: "resume-via-pull" };
  } else if (opts.primarySessionId && row.id === opts.primarySessionId) {
    resume = { resumable: true };
  } else if (opts.primarySessionId && row.kind === "dev") {
    // A dev session on this PR that a newer dev session replaced as the resume anchor.
    resume = { resumable: false, reason: "superseded" };
  } else {
    // Runtime-resumable but not the PR's anchor: a non-dev session linked to the PR, or a PR with
    // no anchor at all (primarySessionId null). `lh resume <pr>` has nothing of this row to re-enter.
    resume = { resumable: false, reason: "not-anchor" };
  }
  return { ...base, linked_at: row.linked_at ?? null, resume };
}

// The full related-sessions list for an issues row (issue or PR), newest link first. `primarySessionId`
// is the PR's primary dev session (primaryDevSessionForPull) — the one `lh resume <pr>` actually
// re-enters — so only that row is marked directly resumable; pass it for PR containers, omit it for
// issue containers.
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

export function relatedSessionsUsageJSON(sessions: any[]) {
  const out = {
    sessions_with_usage: 0,
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: null as number | null,
    has_unknown_cost: false,
  };
  let knownCost = 0;
  for (const session of sessions) {
    const usage = Array.isArray(session.usage) ? session.usage : [];
    if (usage.length === 0) continue;
    out.sessions_with_usage += 1;
    for (const row of usage) {
      out.input_tokens += row.input_tokens;
      out.cache_creation_input_tokens += row.cache_creation_input_tokens;
      out.cache_read_input_tokens += row.cache_read_input_tokens;
      out.output_tokens += row.output_tokens;
      out.total_tokens +=
        row.input_tokens +
        row.cache_creation_input_tokens +
        row.cache_read_input_tokens +
        row.output_tokens;
      if (row.cost_usd == null) out.has_unknown_cost = true;
      else knownCost += row.cost_usd;
    }
  }
  out.cost_usd =
    out.sessions_with_usage === 0 || out.has_unknown_cost ? null : knownCost;
  return out;
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

// Shape a `handoffs` row (#352) into the wire object the CLI / UI read. pr and issue are summarized
// by number (not the internal issues row id) so consumers see the PR/issue they know. body is the
// inline content (instruction prompt / Verify report) when present; src+hash reference a canonical
// copy (plan=PR, diff=commit) when the substance lives elsewhere. cost is returned as-is (free-form
// text the consumer parses). from/to mirror the orchestration roles.
export function handoffJSON(h: any) {
  const prRow = h.pr_id != null ? S.getIssueById(h.pr_id) : null;
  const issueRow = h.issue_id != null ? S.getIssueById(h.issue_id) : null;
  return {
    id: h.id,
    seq: h.seq,
    phase: h.phase,
    direction: h.direction,
    from: h.from_role ?? null,
    to: h.to_role ?? null,
    pull_request: prRow ? { number: prRow.number } : null,
    issue: issueRow ? { number: issueRow.number } : null,
    session_id: h.session_id ?? null,
    body: h.body ?? null,
    src: h.src ?? null,
    hash: h.hash ?? null,
    summary: h.summary ?? null,
    model: h.model ?? null,
    cost: h.cost ?? null,
    created_at: h.created_at,
  };
}

export function labelJSON(l: any) {
  return { name: l.name, color: l.color };
}

// Shape an `issue_groups` row (#312). `members` is the count, not the rows, so a list/summary
// stays cheap; the full ordered membership is fetched via the dedicated members procedure.
export function issueGroupJSON(g: any) {
  return {
    id: g.id,
    name: g.name,
    members: S.countGroupMembers(g.id),
    created_at: g.created_at,
    updated_at: g.updated_at,
  };
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

function linkedPullSummaries(repo: S.Repo, issueRowId: number) {
  return S.allLinkedPullsForIssue(issueRowId).map((pr) =>
    pullSummary(repo, pr),
  );
}

function pullSummary(repo: S.Repo, pr: any) {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: !!pr.merged,
    html_url: linkedRef(repo, "pulls", pr.number).html_url,
    // #629: the exported GitHub PR (if any), so the issue-detail linked-PR row can show a GH badge.
    github_pull: githubPullJSON(S.getGithubPull(pr.id)),
  };
}

// Git-derived status fields for a PR row: mergeable state, diff totals, the
// "working" flag, and review state. Shared by pullJSON (PR list/detail) and the
// issue list's linked-PR summary so both compute status identically. The git
// fan-out (revParse/mergePreview/diffStat/status) is bounded — callers keep
// their lists paginated.
async function pullStatusFields(repo: S.Repo, row: any) {
  const p = S.getPull(row.id);
  const headSha = await revParse(repo.local_path, p.head_ref);
  const baseSha = await revParse(repo.local_path, p.base_ref);
  const review_state = S.computeReviewState(row.id);
  // Merge gate aggregates reviews per topic (#427): clean requires every review
  // topic to pass, not a single PASS — review_state above stays the display
  // signal for the overall PR state.
  const reviewGate = S.computeReviewGate(row.id);
  let mergeable: boolean | null = null;
  let mergeable_state = "unknown";
  if (!p.merged && headSha && baseSha) {
    const [prev, ahead] = await Promise.all([
      mergePreview(repo.local_path, p.base_ref, p.head_ref),
      commitsAhead(repo.local_path, p.base_ref, p.head_ref),
    ]);
    ({ mergeable, mergeable_state } = resolveMergeable({
      hasCommits: ahead > 0,
      conflict: prev.conflict,
      reviewed: reviewGate.reviewed,
      allTopicsPassed: reviewGate.allTopicsPassed,
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
    prNumber: row.number,
    merged: !!p.merged,
    state: row.state,
  });
  // Deterministic path of the `lh dev` worktree backing this PR (same convention as the
  // "working" flag above), so a consumer can show / copy it without knowing worktreeRoot.
  // Pure path math (no fs); null only for a crafted repo name that can't form a safe path.
  let worktree_path: string | null = null;
  try {
    const identity = resolveWorktreeIdentity(p.head_ref, row.number);
    worktree_path =
      identity.scheme === "legacy-issue"
        ? legacyWorktreePath(worktreeRoot(), repo.full_name, identity.number)
        : worktreePath(worktreeRoot(), repo.full_name, identity.number);
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
    worktree_path,
  };
}

// #406: the PR's effective write action ('merge' | 'github_pr') and the exported GitHub PR (if any).
// Kept out of pullStatusFields (shared by the PR list and the issue-list linked-PR summary, neither
// of which renders the action) so only pullJSON pays for it. The GitHub-remote check is a repo-level
// constant resolved here once per PR detail, instead of being spent — and discarded — by every
// linked-PR summary row.
async function pullMergeFields(repo: S.Repo, rowId: number) {
  const merge_mode = effectiveMergeMode(
    repo.merge_mode,
    isGithubRemoteUrl(await remoteUrl(repo.local_path)),
  );
  return { merge_mode, github_pull: githubPullJSON(S.getGithubPull(rowId)) };
}

async function pullMainMergeUndoStatus(repo: S.Repo, p: any) {
  const withRepoWriteStatus = (
    status: ReturnType<typeof assessMainMergeUndo>,
  ) =>
    status.can_undo && S.isArchived(repo)
      ? { ...status, can_undo: false, reason: "Repository is archived" }
      : status;

  if (!p.merged && p.base_ref !== "main") {
    return withRepoWriteStatus(
      assessMainMergeUndo({
        merged: !!p.merged,
        baseRef: p.base_ref,
        mergeCommitSha: p.merge_commit_sha ?? null,
        mergeMethod: p.merge_method ?? null,
        currentBaseSha: null,
        mergeParents: null,
      }),
    );
  }
  const [currentBaseSha, mergeParents] = await Promise.all([
    revParse(repo.local_path, p.base_ref),
    p.merge_commit_sha
      ? commitParents(repo.local_path, p.merge_commit_sha)
      : Promise.resolve(null),
  ]);
  return withRepoWriteStatus(
    assessMainMergeUndo({
      merged: !!p.merged,
      baseRef: p.base_ref,
      mergeCommitSha: p.merge_commit_sha ?? null,
      mergeMethod: p.merge_method ?? null,
      currentBaseSha,
      mergeParents,
    }),
  );
}

// Issue list item with its linked PR enriched with status (working / review /
// mergeable / diff totals) for the issue-list Pattern E sub-row. Async because
// the status fields need a bounded git fan-out per linked PR; used only by the
// paginated issues.list path, so issueJSON stays sync for detail/dashboard.
export async function issueListItemJSON(row: any, repo: S.Repo) {
  const out = issueJSON(row, repo);
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

async function linkedPullDetail(repo: S.Repo, pr: any) {
  const status = await pullStatusFields(repo, pr);
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
    // #629: the exported GitHub PR (if any), so the issue-list linked-PR sub-row can show a GH badge.
    github_pull: githubPullJSON(S.getGithubPull(pr.id)),
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
  else if (repo) {
    const pulls = linkedPullSummaries(repo, row.id);
    out.linked_pull_requests = pulls;
    out.linked_pull_request = pulls[0] ?? null;
  }
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

// Work-duration basis values (#456): tells the frontend which signal grounded the `total` figure,
// so it can render an appropriate label rather than a bare number. Unlike the implementation/review
// phase split below, `total` always reflects the PR's *current* state — it keeps growing through
// "in_progress" and "in_review" until the PR reaches a terminal state ("merged" / "closed").
//   - "merged": session start → merged_at (terminal — the work is finished).
//   - "closed": session start → the issue row's closed_at (terminal — the PR was closed without
//     merging, rejected/abandoned).
//   - "in_review": session start → now — the PR has reached its first ready_for_review event but
//     hasn't merged or closed yet, so the clock is still running.
//   - "in_progress": session start → now — no ready_for_review event yet (still draft, or ready
//     with no recorded event), so the clock is still running.
export type PullWorkDurationBasis =
  | "merged"
  | "closed"
  | "in_review"
  | "in_progress";

// One phase's elapsed time (#456): `done` distinguishes a phase that reached its own terminal event
// (so `seconds` is fixed) from one still measured up to "now" (so `seconds` keeps growing on the
// next read).
export interface PullWorkPhase {
  seconds: number | null;
  done: boolean;
}

export interface PullWorkDuration {
  // The whole PR: session start → the clearest completion signal, or "now" while still open. See
  // PullWorkDurationBasis for what grounds each value.
  total: { seconds: number | null; basis: PullWorkDurationBasis | null };
  // Session start → the first ready_for_review event (or → the PR's own end signal, for a PR that
  // was merged/closed without ever passing through a draft→ready transition — see below). Null only
  // when there is no dev session to anchor from (mirrors `total.basis === null`).
  implementation: PullWorkPhase | null;
  // The first ready_for_review event → merged_at/closed_at, or → now while still under review. Null
  // until the PR has reached ready_for_review at least once — there is nothing to report yet.
  review: PullWorkPhase | null;
}

// How long the PR's dev session took (#456), split into three figures anchored at the primary dev
// session's start (agent_sessions.created_at — set once at `lh dev`/`sessions.register` and never
// touched again by resumes, so it is a stable start marker):
//   - total: start → the clearest completion signal (see PullWorkDurationBasis), or now.
//   - implementation: start → the first ready_for_review event — the phase before a
//     reviewer/human ever saw the PR. A PR that merges/closes without ever passing through
//     draft→ready (e.g. a plain non-draft `pulls.create`) has no ready_for_review event to anchor
//     to; implementation then covers the PR's whole life and `review` stays null, since there is no
//     signal marking a review phase ever began.
//   - review: the first ready_for_review event → merged_at/closed_at/now — review + any fix-cycle
//     time after the implementation handoff.
// Returns `{ total: { seconds: null, basis: null }, implementation: null, review: null }` — the
// fallback the frontend renders as "N/A" — when there is no dev session to anchor the calculation.
function pullWorkDuration(
  repo: S.Repo,
  row: any,
  p: any,
  primarySessionId: string | null,
): PullWorkDuration {
  const naFields = {
    total: { seconds: null, basis: null },
    implementation: null,
    review: null,
  };
  if (!primarySessionId) return naFields;
  const session = S.getAgentSession(primarySessionId);
  const startedAt = session ? Date.parse(session.created_at) : NaN;
  if (Number.isNaN(startedAt)) return naFields;

  const now = Date.now();
  const mergedAt = p.merged && p.merged_at ? Date.parse(p.merged_at) : null;
  // Closed without merging (rejected/abandoned). Anchored at row.closed_at — stamped once at the
  // open->closed transition (store.ts updateIssue) — not row.updated_at, which every field edit
  // bumps; anchoring to updated_at would let a later title/body edit on an already-closed PR
  // silently inflate the reported duration. Falls back to updated_at only for a row whose closed_at
  // wasn't backfilled (defensive; the db.ts migration backfills every closed row).
  const closedAt =
    row.state === "closed" && mergedAt == null
      ? Date.parse(row.closed_at ?? row.updated_at)
      : null;
  const readyAtStr = S.firstReadyForReviewAt(repo.id, row.number);
  const readyAt = readyAtStr ? Date.parse(readyAtStr) : null;

  let totalEndedAt: number;
  let basis: PullWorkDurationBasis;
  if (mergedAt != null && !Number.isNaN(mergedAt)) {
    totalEndedAt = mergedAt;
    basis = "merged";
  } else if (closedAt != null && !Number.isNaN(closedAt)) {
    totalEndedAt = closedAt;
    basis = "closed";
  } else if (readyAt != null && !Number.isNaN(readyAt)) {
    totalEndedAt = now;
    basis = "in_review";
  } else {
    totalEndedAt = now;
    basis = "in_progress";
  }
  const total =
    Number.isNaN(totalEndedAt) || totalEndedAt < startedAt
      ? { seconds: null, basis: null }
      : { seconds: Math.round((totalEndedAt - startedAt) / 1000), basis };

  // Implementation ends at the first ready_for_review event; failing that, at whichever terminal
  // signal (merged/closed) closed the PR without one ever firing; failing that, "now" (still WIP).
  const implEndedAt =
    readyAt != null && !Number.isNaN(readyAt)
      ? readyAt
      : (mergedAt ?? closedAt ?? now);
  const implDone = readyAt != null || mergedAt != null || closedAt != null;
  const implementation =
    Number.isNaN(implEndedAt) || implEndedAt < startedAt
      ? null
      : {
          seconds: Math.round((implEndedAt - startedAt) / 1000),
          done: implDone,
        };

  // Review has nothing to report until the PR has reached ready_for_review at least once.
  let review: PullWorkPhase | null = null;
  if (readyAt != null && !Number.isNaN(readyAt)) {
    const reviewEndedAt = mergedAt ?? closedAt ?? now;
    const reviewDone = mergedAt != null || closedAt != null;
    review =
      Number.isNaN(reviewEndedAt) || reviewEndedAt < readyAt
        ? null
        : {
            seconds: Math.round((reviewEndedAt - readyAt) / 1000),
            done: reviewDone,
          };
  }

  return { total, implementation, review };
}

export async function pullJSON(
  repo: S.Repo,
  row: any,
  opts: { withRelatedSessions?: boolean } = {},
) {
  const p = S.getPull(row.id);
  const status = await pullStatusFields(repo, row);
  const mergeFields = await pullMergeFields(repo, row.id);
  const mainMergeUndo = opts.withRelatedSessions
    ? await pullMainMergeUndoStatus(repo, p)
    : null;

  return {
    number: row.number,
    state: row.state,
    title: row.title,
    body: row.body,
    user: { login: row.author },
    head: { ref: p.head_ref, sha: status.headSha },
    base: { ref: p.base_ref, sha: status.baseSha },
    merged: !!p.merged,
    // draft (#413): true while the PR is WIP (opened by `lh dev` at the start of work);
    // cleared by `lh pr ready-for-review`. Lets list/view and consumers tell WIP from reviewable.
    draft: !!p.draft,
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
    ...(mainMergeUndo ? { main_merge_undo: mainMergeUndo } : {}),
    labels: S.issueLabels(row.id).map(labelJSON),
    comments: S.countComments(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    linked_issue: status.linked,
    worktree_path: status.worktree_path,
    // #406: the effective write action for this PR ('merge' | 'github_pr') and the GitHub PR it was
    // exported to (null until the export skill records one). The UI swaps Merge ⟷ Create/View PR.
    merge_mode: mergeFields.merge_mode,
    github_pull: mergeFields.github_pull,
    // Detail-only (#298, #456): the PR's related sessions and derived work duration, newest first.
    // Gated so the PR list/dashboard stay O(1) git + no extra per-row query. Both share the same
    // primarySessionId lookup (primaryDevSessionForPull) — the PR's resume/retro anchor — so it is
    // computed once here rather than twice.
    ...(opts.withRelatedSessions
      ? (() => {
          const primarySessionId = S.primaryDevSessionForPull(row.id);
          const relatedSessions = relatedSessionsJSON(row, {
            primarySessionId,
          });
          return {
            related_sessions: relatedSessions,
            related_sessions_usage: relatedSessionsUsageJSON(relatedSessions),
            work_duration: pullWorkDuration(repo, row, p, primarySessionId),
          };
        })()
      : {}),
  };
}
