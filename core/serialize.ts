// JSON serializers: shape store rows into the stable wire objects that consumers
// (CLI now, JSON-RPC clients later) read. Kept separate from service.ts so the
// shaping is reusable and side-effect free.

import { statSync } from "node:fs";
import { worktreeRoot } from "./config.ts";
import {
  commitsAhead,
  diffStat,
  mergePreview,
  remoteUrl,
  revParse,
} from "./git.ts";
import { linkedRef } from "./links.ts";
import type { MergeMode } from "./merge-mode.ts";
import { effectiveMergeMode, isGithubRemoteUrl } from "./merge-mode.ts";
import type { MergeableState } from "./mergeable.ts";
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

export interface RepoWire {
  id: number;
  name: string;
  full_name: string;
  owner: UserWire;
  default_branch: string;
  local_path: string;
  created_at: string;
  archived: boolean;
  archived_at: string | null;
  favorite: boolean;
  favorited_at: string | null;
  // #406: raw per-repo setting only ('merge' | 'github_pr' | null). The effective mode (which
  // resolves the null default against the GitHub remote) needs a git call, so it is served by the
  // dedicated repos/mergeMode procedure, not this sync serializer.
  merge_mode: MergeMode | null;
}

export function repoJSON(r: S.Repo): RepoWire {
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
    merge_mode: (r.merge_mode as MergeMode | null) ?? null,
  };
}

export interface UserWire {
  login: string;
}

export interface SessionUsageWire {
  session_id: string;
  model: string;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  updated_at: string;
}

export interface SessionSubagentUsageWire extends SessionUsageWire {
  source_id: string;
  parent_source_id: string | null;
  label: string | null;
  kind: string;
}

export interface SessionLinkedTargetWire {
  repo: string;
  kind: "issue" | "pull";
  number: number;
  title: string;
  state: "open" | "closed";
}

export interface AgentSessionWire {
  id: string;
  agent: string;
  session: string;
  created_at: string;
  updated_at: string;
  name?: string;
  runtime?: string;
  kind?: string;
  usage?: SessionUsageWire[];
  subagent_usage?: SessionSubagentUsageWire[];
  linked_targets?: SessionLinkedTargetWire[];
}

export interface RelatedSessionWire extends AgentSessionWire {
  linked_at: string | null;
  resume: { resumable: boolean; reason?: string };
}

export interface LabelWire {
  name: string;
  color: string | null;
}

export interface PullSummaryWire {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  html_url: string;
  github_pull: GithubPullWire | null;
  // Agent cost for the issue-list PR sub-row (#783): total tokens across every linked session and
  // the summed cost, or absent/null when no linked session has usage yet / has an unknown cost.
  total_tokens?: number;
  cost_usd?: number | null;
}

// Extra fields present only on the issue-list linked-PR sub-row (issueListItemJSON's
// linkedPullDetail), which runs the git status fan-out; the issue-detail summary
// (pullSummary) does not, so those rows stay the plain PullSummaryWire.
export interface IssueListPullSummaryWire extends PullSummaryWire {
  working: boolean;
  review_state: S.ReviewState;
  mergeable_state: MergeableState;
  additions: number;
  deletions: number;
  changed_files: number;
  agent_runtime?: string;
  agent_model?: string;
}

// Herdr pane captured from the New Issue flow (#670). Narrowed from the `issue_herdr_panes` row —
// repo_id/issue_id/created_at/updated_at are internal bookkeeping, not part of the wire contract.
export interface HerdrPaneWire {
  launch_id: string;
  pane_id: string | null;
  session_name: string | null;
}

export function herdrPaneJSON(
  p: S.IssueHerdrPane | null,
): HerdrPaneWire | null {
  if (!p) return null;
  return {
    launch_id: p.launch_id,
    pane_id: p.pane_id,
    session_name: p.session_name,
  };
}

export interface IssueWire {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  user: UserWire;
  labels: LabelWire[];
  comments: number;
  // Full comment bodies (author, time, text). Populated only on the issue-detail response
  // (issues.get), not the list — so the list stays cheap with just the `comments` count (#231).
  comment_list?: CommentWire[];
  created_at: string;
  updated_at: string;
  // Sessions related to this issue (#298), newest first. Detail response only.
  related_sessions?: RelatedSessionWire[];
  // Herdr pane captured from the New Issue flow (#670). Detail response only.
  herdr_pane?: HerdrPaneWire | null;
  pull_request?: { url: string };
  linked_pull_requests?: PullSummaryWire[];
  linked_pull_request?: PullSummaryWire | null;
  github_issue?: GithubIssueWire | null;
}

interface RetroRubricWire {
  severity: string;
  id: string;
  signal: string;
  value?: string | number | null;
  note?: string | null;
}

interface RetroFindingWire {
  severity: string;
  category: string;
  note: string;
  evidence_ref?: string | null;
  proposed_action?: string | null;
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
  // #813: whether lh-worker's polling (github-merge-sync.ts) has detected this GitHub PR as
  // merged, and when — drives the "Mark as merged" action in the UI.
  github_merged: boolean;
  github_merged_at: string | null;
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
    github_merged: !!g.github_merged,
    github_merged_at: g.github_merged_at ?? null,
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
  row: S.AgentSessionRow | S.LinkedAgentSessionRow,
  opts: { withLinkedTargets?: boolean } = {},
): AgentSessionWire {
  const out: AgentSessionWire = {
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

export function sessionLinkedTargetJSON(
  row: S.SessionLinkedTargetRow,
): SessionLinkedTargetWire {
  return {
    repo: row.repo,
    kind: row.kind,
    number: row.number,
    title: row.title,
    state: row.state as "open" | "closed",
  };
}

export function sessionUsageJSON(row: S.SessionUsageRow): SessionUsageWire {
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

export function sessionSubagentUsageJSON(
  row: S.SessionSubagentUsageRow,
): SessionSubagentUsageWire {
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
  row: S.LinkedAgentSessionRow,
  opts: { container: "issue" | "pull"; primarySessionId?: string | null },
): RelatedSessionWire {
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
  containerRow: S.IssueRow,
  opts: { primarySessionId?: string | null } = {},
): RelatedSessionWire[] {
  const container = containerRow.kind === "pull" ? "pull" : "issue";
  return S.listSessionsForIssue(containerRow.id).map((row) =>
    relatedSessionJSON(row, {
      container,
      primarySessionId: opts.primarySessionId,
    }),
  );
}

export interface UsageTotalsWire {
  sessions_with_usage: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  // Null when any included usage row has an unknown model price.
  cost_usd: number | null;
  has_unknown_cost: boolean;
}

// Same totals as UsageTotalsWire, scoped to sessions of one `kind` (dev/review/issue-create/...).
export interface RelatedSessionsUsageByKindWire extends UsageTotalsWire {
  kind: string;
}

export interface RelatedSessionsUsageWire extends UsageTotalsWire {
  // Per-`kind` breakdown of the same totals (#810), sessions with no usage rows excluded.
  by_kind: RelatedSessionsUsageByKindWire[];
}

function sumUsageTotals(
  sessions: Array<{ usage?: SessionUsageWire[] }>,
): UsageTotalsWire {
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

export function relatedSessionsUsageJSON(
  sessions: Array<{ kind?: string; usage?: SessionUsageWire[] }>,
): RelatedSessionsUsageWire {
  const byKind = new Map<string, Array<{ usage?: SessionUsageWire[] }>>();
  for (const session of sessions) {
    const kind = session.kind ?? "unknown";
    const bucket = byKind.get(kind);
    if (bucket) bucket.push(session);
    else byKind.set(kind, [session]);
  }
  const by_kind = Array.from(byKind.entries())
    .map(([kind, group]) => ({ kind, ...sumUsageTotals(group) }))
    .filter((entry) => entry.sessions_with_usage > 0)
    .sort((a, b) => a.kind.localeCompare(b.kind));
  return { ...sumUsageTotals(sessions), by_kind };
}

export interface CommentWire {
  id: number;
  user: UserWire;
  body: string;
  created_at: string;
}

export function commentJSON(m: S.CommentRow): CommentWire {
  return {
    id: m.id,
    user: { login: m.author },
    body: m.body,
    created_at: m.created_at,
  };
}

export interface ReviewWire {
  id: number;
  user: UserWire;
  // Not narrowed to "PASS" | "REQUEST_CHANGES" | "COMMENT": reviews.create (core/service/reviews.ts)
  // only special-cases "APPROVE" -> "PASS" and otherwise stores the caller's uppercased string
  // verbatim, so the wire value isn't actually guaranteed to be one of the three.
  state: string;
  body: string;
  // The commit this review was made against (lets clients group reviews by
  // commit, e.g. #208) and its aspect/topic (#209). Both may be null.
  head_sha: string | null;
  topic: string | null;
  submitted_at: string;
}

export function reviewJSON(v: S.ReviewRow): ReviewWire {
  return {
    id: v.id,
    user: { login: v.author },
    state: v.event,
    body: v.body,
    head_sha: v.head_sha ?? null,
    topic: v.topic ?? null,
    submitted_at: v.created_at,
  };
}

export interface ReviewCommentWire {
  id: number;
  pull_request_review_id: number | null;
  user: UserWire;
  path: string;
  line: number | null;
  // Not narrowed to "LEFT" | "RIGHT": reviews.create passes the caller's `side` straight through
  // (only defaulting a missing value to "RIGHT"), so the wire value isn't actually guaranteed to
  // be one of the two.
  side: string | null;
  body: string;
  created_at: string;
}

export function reviewCommentJSON(m: S.ReviewCommentRow): ReviewCommentWire {
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

// An orchestrator<->subagent handoff (#352), as shown in the PR detail's Handoffs section. `body`
// is inline content (instruction / Verify report) when present; otherwise `src` references a
// canonical copy (plan=PR, diff=commit) and `hash` is its content hash.
export interface HandoffWire {
  id: number;
  seq: number;
  phase: string;
  direction: "down" | "up";
  from: string | null;
  to: string | null;
  pull_request: { number: number } | null;
  issue: { number: number } | null;
  session_id: string | null;
  body: string | null;
  src: string | null;
  hash: string | null;
  summary: string | null;
  model: string | null;
  cost: string | null;
  created_at: string;
}

// Shape a `handoffs` row (#352) into the wire object the CLI / UI read. pr and issue are summarized
// by number (not the internal issues row id) so consumers see the PR/issue they know. body is the
// inline content (instruction prompt / Verify report) when present; src+hash reference a canonical
// copy (plan=PR, diff=commit) when the substance lives elsewhere. cost is returned as-is (free-form
// text the consumer parses). from/to mirror the orchestration roles.
export function handoffJSON(h: S.HandoffRow): HandoffWire {
  const prRow = h.pr_id != null ? S.getIssueById(h.pr_id) : null;
  const issueRow = h.issue_id != null ? S.getIssueById(h.issue_id) : null;
  return {
    id: h.id,
    seq: h.seq,
    phase: h.phase,
    direction: h.direction as HandoffWire["direction"],
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

export function labelJSON(l: S.LabelRow): LabelWire {
  return { name: l.name, color: l.color };
}

// An issue group (#312): a repo-scoped, ordered collection of issues. `members` is the count, not
// the rows, so a list/summary stays cheap; the full ordered membership is fetched via the
// dedicated members procedure.
export interface IssueGroupWire {
  id: number;
  name: string;
  members: number;
  created_at: string;
  updated_at: string;
}

// Shape an `issue_groups` row (#312). `members` is the count, not the rows, so a list/summary
// stays cheap; the full ordered membership is fetched via the dedicated members procedure.
export function issueGroupJSON(g: S.IssueGroupRow): IssueGroupWire {
  return {
    id: g.id,
    name: g.name,
    members: S.countGroupMembers(g.id),
    created_at: g.created_at,
    updated_at: g.updated_at,
  };
}

// Summary of the issue a PR closes (pull-detail `linked_issue`).
export interface LinkedIssueWire {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
}

function linkedIssueSummary(
  repo: S.Repo,
  pullRowId: number,
): LinkedIssueWire | null {
  const p = S.getPull(pullRowId)!;
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

function pullSummary(repo: S.Repo, pr: S.LinkedPullIssueRow): PullSummaryWire {
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
interface PullStatusFields {
  headSha: string | null;
  baseSha: string | null;
  mergeable: boolean | null;
  mergeable_state: MergeableState;
  additions: number;
  deletions: number;
  changed_files: number;
  working: boolean;
  review_state: S.ReviewState;
  linked: LinkedIssueWire | null;
  worktree_path: string | null;
}

async function pullStatusFields(
  repo: S.Repo,
  row: S.IssueRow,
): Promise<PullStatusFields> {
  const p = S.getPull(row.id)!;
  const headSha = await revParse(repo.local_path, p.head_ref);
  const baseSha = await revParse(repo.local_path, p.base_ref);
  const review_state = S.computeReviewState(row.id);
  // Merge gate aggregates reviews per topic (#427): clean requires every review
  // topic to pass, not a single PASS — review_state above stays the display
  // signal for the overall PR state.
  const reviewGate = S.computeReviewGate(row.id);
  let mergeable: boolean | null = null;
  let mergeable_state: MergeableState = "unknown";
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
  // Path of the existing `lh dev` worktree backing this PR (same convention as the
  // "working" flag above), so a consumer can show / copy it without knowing worktreeRoot.
  // Null when the path is unsafe or the worktree directory has not been provisioned / was removed.
  let worktree_path: string | null = null;
  try {
    const identity = resolveWorktreeIdentity(p.head_ref, row.number);
    const candidate =
      identity.scheme === "legacy-issue"
        ? legacyWorktreePath(worktreeRoot(), repo.full_name, identity.number)
        : worktreePath(worktreeRoot(), repo.full_name, identity.number);
    worktree_path = statSync(candidate).isDirectory() ? candidate : null;
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
interface PullMergeFields {
  merge_mode: MergeMode;
  github_pull: GithubPullWire | null;
}

async function pullMergeFields(
  repo: S.Repo,
  rowId: number,
): Promise<PullMergeFields> {
  const merge_mode = effectiveMergeMode(
    repo.merge_mode,
    isGithubRemoteUrl(await remoteUrl(repo.local_path)),
  );
  return { merge_mode, github_pull: githubPullJSON(S.getGithubPull(rowId)) };
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

async function linkedPullDetail(
  repo: S.Repo,
  pr: S.LinkedPullIssueRow,
): Promise<IssueListPullSummaryWire> {
  const status = await pullStatusFields(repo, pr);
  const usageTotals = S.sessionUsageTotalsForIssue(pr.id);
  const agent = S.pullAgentSummary(pr.id);
  const runtime = agent ? sessionRuntime(agent) : null;
  const model = agent?.models.length ? agent.models.join(", ") : null;
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
    ...(runtime ? { agent_runtime: runtime } : {}),
    ...(model ? { agent_model: model } : {}),
    // #629: the exported GitHub PR (if any), so the issue-list linked-PR sub-row can show a GH badge.
    github_pull: githubPullJSON(S.getGithubPull(pr.id)),
    // #783: agent cost (total tokens + cost) for the sub-row, or omitted when no linked session
    // has usage yet.
    ...(usageTotals
      ? {
          total_tokens: usageTotals.total_tokens,
          cost_usd: usageTotals.cost_usd,
        }
      : {}),
  };
}

export function issueJSON(row: S.IssueRow, repo?: S.Repo): IssueWire {
  const out: IssueWire = {
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

function safeParseArray<T>(json: string | null | undefined): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

// Shape a `retros` row into the wire object the CLI (and later JSON-RPC) reads.
// pr / issue are summarized from their issues rows so consumers see numbers, not
// internal row ids. rubric / findings are parsed back from their JSON columns.
export function retroJSON(row: S.RetroRow) {
  const prRow = row.pr_id != null ? S.getIssueById(row.pr_id) : null;
  const issueRow = row.issue_id != null ? S.getIssueById(row.issue_id) : null;
  return {
    id: row.id,
    pr: prRow ? { number: prRow.number, title: prRow.title } : null,
    issue: issueRow ? { number: issueRow.number, title: issueRow.title } : null,
    session_id: row.session_id ?? null,
    rubric: safeParseArray<RetroRubricWire>(row.rubric_json),
    findings: safeParseArray<RetroFindingWire>(row.findings_json),
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
  row: S.IssueRow,
  p: S.PullRow,
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

export interface PullWire {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  user: UserWire;
  head: { ref: string; sha: string | null };
  base: { ref: string; sha: string | null };
  merged: boolean;
  // draft (#413): true while the PR is WIP (opened by `lh dev` at the start of work);
  // cleared by `lh pr ready-for-review`. Lets list/view and consumers tell WIP from reviewable.
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: MergeableState;
  merge_commit_sha: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  working: boolean;
  review_state: S.ReviewState;
  changes_addressed_at: string | null;
  changes_addressed_by: string | null;
  labels: LabelWire[];
  comments: number;
  created_at: string;
  updated_at: string;
  linked_issue: LinkedIssueWire | null;
  worktree_path: string | null;
  // #406: the effective write action for this PR ('merge' | 'github_pr') and the GitHub PR it was
  // exported to (null until the export skill records one). The UI swaps Merge ⟷ Create/View PR.
  merge_mode: MergeMode;
  github_pull: GithubPullWire | null;
  // Detail-only (#298, #456): the PR's related sessions, aggregate usage, and derived work
  // duration. Gated so the PR list/dashboard stay O(1) git + no extra per-row query.
  related_sessions?: RelatedSessionWire[];
  related_sessions_usage?: RelatedSessionsUsageWire;
  work_duration?: PullWorkDuration;
}

export async function pullJSON(
  repo: S.Repo,
  row: S.IssueRow,
  opts: { withRelatedSessions?: boolean } = {},
): Promise<PullWire> {
  const p = S.getPull(row.id)!;
  const status = await pullStatusFields(repo, row);
  const mergeFields = await pullMergeFields(repo, row.id);

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
