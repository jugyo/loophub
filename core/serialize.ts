// JSON serializers: shape store rows into the stable wire objects that consumers
// (CLI now, JSON-RPC clients later) read. Kept separate from service.ts so the
// shaping is reusable and side-effect free.

import { statSync } from "node:fs";
import { agentEffort, agentModel, worktreeRoot } from "./config.ts";
import {
  commitLog,
  commitsAhead,
  diffStat,
  hasEffectiveDiff,
  mergePreview,
  pushedCommitShas,
  remoteUrl,
  revParse,
} from "./git.ts";
import type { GhPrStatus } from "./github.ts";
import { linkedRef } from "./links.ts";
import type { MergeMode } from "./merge-mode.ts";
import { effectiveMergeMode, isGithubRemoteUrl } from "./merge-mode.ts";
import type { MergeableState } from "./mergeable.ts";
import { resolveMergeable } from "./mergeable.ts";
import { resolvePullBaseSha } from "./pull-base.ts";
import { pullWorktreeDirty } from "./pull-worktree.ts";
import {
  resolveRuntimeResume,
  resolveWorktreeIdentity,
  SESSION_KIND_ISSUE_CREATE,
  sessionRuntime,
} from "./resume.ts";
import type { CodingAgent } from "./runtimes.ts";
import * as S from "./store.ts";
import type {
  HerdrAgent,
  HerdrIssueWorkspace,
  HerdrPullWorkspace,
} from "./terminal/herdr-status.ts";
import { herdrSessionName } from "./terminal/terminal-launch.ts";
import type { WorkflowHerdrAgent } from "./workflow/herdr-agents.ts";
import { legacyWorktreePath, worktreePath } from "./worktree-path.ts";

// Wire-type SSOT (AGENTS.md): the coding-runtime id is part of several wire shapes below (agent cost
// summary, scheduled tasks, per-agent settings). Re-export it from the registry so web/src/api/types.ts
// derives `CodingAgent` from core via a type-only import instead of re-declaring the union.
export type { CodingAgent } from "./runtimes.ts";

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
  // #878: deterministic herdr session name for this repo (repoPart + hash of full_name/local_path),
  // the same value every herdr launch derives (see herdrSessionName). Surfaced so the repo page can
  // show a copyable `herdr --session <name>` start/connect command without a herdr call.
  herdr_session_name: string;
}

export interface RepoMergeModeWire {
  setting: MergeMode | null;
  has_github_remote: boolean;
  effective: MergeMode;
}

export interface WorkspaceWire {
  branch: string;
  created_at: string;
  archived_at: string | null;
  branch_exists: boolean;
}

export function workspaceJSON(
  workspace: S.Workspace,
  branchExists: boolean,
): WorkspaceWire {
  return {
    branch: workspace.branch,
    created_at: workspace.created_at,
    archived_at: workspace.archived_at,
    branch_exists: branchExists,
  };
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
    herdr_session_name: herdrSessionName(r),
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
  context_usage_percent: number | null;
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

export interface AgentCostSummaryWire {
  agent: CodingAgent;
  month: number | null;
  week: number | null;
  day: number | null;
  // Two hours of aggregate token rates as 24 oldest-to-newest five-minute buckets. Surfaced on
  // the first row of the compact statusbar cost-summary payload to avoid a separate polling endpoint.
  // Missing buckets are zero, and the final bucket includes the current live rate.
  tokens_per_5m_history?: number[];
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
  draft?: boolean;
  html_url: string;
  github_pull: GithubPullWire | null;
  // Agent cost for the issue-list PR sub-row (#783): total tokens across every linked session and
  // the summed cost, or absent/null when no linked session has usage yet / has an unknown cost.
  total_tokens?: number;
  cost_usd?: number | null;
  // Detail/list enrichment: commits added to the current base since this PR forked.
  base_commits_behind?: number;
  // #863: the PR has at least one `dev.cost_stopped` event — its dev agent was force-stopped for
  // exceeding the cost limit. Drives the "cost stopped" badge on every surface that shows the PR.
  cost_stopped: boolean;
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
  // Commits the head is ahead of the base by; zero means the attempt has no commits yet, so the
  // issue-detail card hides the (meaningless) Diff and Review fields until work lands.
  commits_ahead: number;
  // Required on enriched rows; zero means the attempt starts from the current base tip.
  base_commits_behind: number;
  agent_runtime?: string;
  agent_model?: string;
  // #882: the PR's total work duration for the sub-row — the same `pullWorkDuration().total` shown
  // in the PR-detail sidebar (#456), not a new calculation. Omitted when there is no dev session to
  // anchor from (the detail path renders that as "N/A"; the sub-row just drops the item).
  work_duration_total?: { seconds: number; basis: PullWorkDurationBasis };
}

// Herdr pane captured from the New Issue flow (#670). Narrowed from its compatibility store row —
// generic ownership, display, origin, and timestamps remain internal to this wire shape.
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
  target_branch: string | null;
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
  // Herdr pane captured from the New Issue flow (#670). Populated on issue list and detail
  // responses so every shared IssueRow can expose the pane action without a detail fetch.
  herdr_pane?: HerdrPaneWire | null;
  pull_request?: { url: string };
  linked_pull_requests?: PullSummaryWire[];
  linked_pull_request?: PullSummaryWire | null;
  linked_pull_requests_truncated?: boolean;
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
  // Whether lh-worker's polling (github-merge-sync.ts) has detected this GitHub PR as merged,
  // and when. The detail view keeps displaying this status after the manual merge action retires.
  github_merged: boolean;
  github_merged_at: string | null;
  // #848: the loophub head SHA last pushed to the GitHub branch (null if never pushed from here).
  // The PR-detail "push local changes" button compares this against the PR's live head.sha: they
  // differ exactly when commits added after the export have not yet reached the GitHub branch.
  pushed_sha: string | null;
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
    pushed_sha: g.pushed_sha ?? null,
  };
}

// #850: the GitHub-side status of a PR's linked GitHub PR, for the PR-detail right sidebar. Sourced
// on demand from `gh` (core/github.ts GhPrStatus) and cached in github_pull_status; `synced_at` is
// when it was last fetched so the UI can show freshness. `comments` (conversation comments) and
// `reviews` (submitted reviews) are separate counts, labeled distinctly in the UI so neither is
// mistaken for the other.
export interface GithubPrStatusWire {
  state: "open" | "closed" | "merged";
  is_draft: boolean;
  merged: boolean;
  mergeable: "mergeable" | "conflicting" | "unknown";
  review_decision: "approved" | "changes_requested" | "review_required" | null;
  checks: "success" | "failure" | "pending" | "none";
  comments: number;
  reviews: number;
  updated_at: string | null;
  synced_at: string;
}

export function githubPrStatusJSON(
  gh: GhPrStatus,
  syncedAt: string,
): GithubPrStatusWire {
  return {
    state: gh.state,
    is_draft: gh.isDraft,
    merged: gh.merged,
    mergeable: gh.mergeable,
    review_decision: gh.reviewDecision,
    checks: gh.checks,
    comments: gh.comments,
    reviews: gh.reviews,
    updated_at: gh.updatedAt,
    synced_at: syncedAt,
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
    context_usage_percent: row.context_usage_percent ?? null,
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
    context_usage_percent: row.context_usage_percent ?? null,
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
  // Max observed current-context usage across included sessions/models. Null when unavailable.
  context_usage_percent: number | null;
}

// Session metadata and aggregate usage attached to a live Herdr pane. The pane itself comes from
// Herdr, while session identity and usage come from LoopHub's persisted session records. Keeping
// this serializer in core makes terminal/sessions the wire-shape source of truth for Web clients.
export interface HerdrPaneSessionWire {
  id: string;
  agent: string;
  runtime: string | null;
  kind: string | null;
  usage: UsageTotalsWire;
}

export interface HerdrSessionAgentWire extends HerdrAgent {
  pull: number | null;
  pull_closed: boolean;
  /** Whether id is a real Herdr pane id that focus/close actions can target. */
  focusable: boolean;
  workflow?: WorkflowHerdrAgent;
  session?: HerdrPaneSessionWire;
}

export interface HerdrRepoSessionsWire {
  repo: string;
  session_name: string;
  agents: HerdrSessionAgentWire[];
  pull_workspaces: HerdrPullWorkspace[];
  issue_workspaces: HerdrIssueWorkspace[];
}

export interface HerdrSessionsWire {
  repos: HerdrRepoSessionsWire[];
  running_repos?: string[];
}

export function herdrPaneSessionJSON(
  sessionId: string | null,
): HerdrPaneSessionWire | null {
  if (!sessionId) return null;
  const row = S.getAgentSession(sessionId);
  if (!row) return null;
  return {
    id: row.id,
    agent: row.agent,
    runtime: row.runtime,
    kind: row.kind,
    usage: sumUsageTotals([
      { usage: S.listSessionUsage(row.id).map(sessionUsageJSON) },
    ]),
  };
}

export interface RelatedSessionsSubagentUsageWire extends UsageTotalsWire {
  session_id: string;
  source_id: string;
  label: string | null;
  kind: string;
}

// Same totals as UsageTotalsWire, scoped to sessions of one `kind` (dev/review/issue-create/...).
export interface RelatedSessionsUsageByKindWire extends UsageTotalsWire {
  kind: string;
  // Per-subagent totals nested under the parent session kind. Omitted when none exist so PR detail
  // does not show empty subagent headings for ordinary sessions.
  subagents?: RelatedSessionsSubagentUsageWire[];
}

export interface RelatedSessionsUsageWire extends UsageTotalsWire {
  // Per-`kind` breakdown of the same totals (#810), sessions with no usage rows excluded.
  by_kind: RelatedSessionsUsageByKindWire[];
}

type UsageLikeWire = Pick<
  SessionUsageWire,
  | "input_tokens"
  | "cache_creation_input_tokens"
  | "cache_read_input_tokens"
  | "output_tokens"
  | "cost_usd"
  | "context_usage_percent"
>;

function sumUsageRows(
  rows: UsageLikeWire[],
  sessionsWithUsage: number,
): UsageTotalsWire {
  const out = {
    sessions_with_usage: sessionsWithUsage,
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: null as number | null,
    has_unknown_cost: false,
    context_usage_percent: null as number | null,
  };
  let knownCost = 0;
  for (const row of rows) {
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
    if (
      typeof row.context_usage_percent === "number" &&
      Number.isFinite(row.context_usage_percent)
    ) {
      out.context_usage_percent = Math.max(
        out.context_usage_percent ?? 0,
        row.context_usage_percent,
      );
    }
  }
  out.cost_usd = rows.length === 0 || out.has_unknown_cost ? null : knownCost;
  return out;
}

function sumUsageTotals(
  sessions: Array<{ usage?: SessionUsageWire[] }>,
): UsageTotalsWire {
  const rows: SessionUsageWire[] = [];
  let sessionsWithUsage = 0;
  for (const session of sessions) {
    const usage = Array.isArray(session.usage) ? session.usage : [];
    if (usage.length === 0) continue;
    sessionsWithUsage += 1;
    rows.push(...usage);
  }
  return sumUsageRows(rows, sessionsWithUsage);
}

function subagentUsageBreakdown(
  sessions: Array<{
    subagent_usage?: SessionSubagentUsageWire[];
  }>,
): RelatedSessionsSubagentUsageWire[] {
  const bySource = new Map<string, SessionSubagentUsageWire[]>();
  for (const session of sessions) {
    const usage = Array.isArray(session.subagent_usage)
      ? session.subagent_usage
      : [];
    for (const row of usage) {
      const key = `${row.session_id}\0${row.source_id}`;
      const bucket = bySource.get(key);
      if (bucket) bucket.push(row);
      else bySource.set(key, [row]);
    }
  }

  return Array.from(bySource.values())
    .map((rows) => {
      const first = rows[0];
      return {
        session_id: first.session_id,
        source_id: first.source_id,
        label: first.label,
        kind: first.kind,
        ...sumUsageRows(rows, 1),
      };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens);
}

export function relatedSessionsUsageJSON(
  sessions: Array<{
    kind?: string;
    usage?: SessionUsageWire[];
    subagent_usage?: SessionSubagentUsageWire[];
  }>,
): RelatedSessionsUsageWire {
  const byKind = new Map<
    string,
    Array<{
      usage?: SessionUsageWire[];
      subagent_usage?: SessionSubagentUsageWire[];
    }>
  >();
  for (const session of sessions) {
    const kind = session.kind ?? "unknown";
    const bucket = byKind.get(kind);
    if (bucket) bucket.push(session);
    else byKind.set(kind, [session]);
  }
  const by_kind = Array.from(byKind.entries())
    .map(([kind, group]) => {
      const subagents = subagentUsageBreakdown(group);
      return {
        kind,
        ...sumUsageTotals(group),
        ...(subagents.length ? { subagents } : {}),
      };
    })
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
  // The agent/model that produced the review (#1107); null when unattributed.
  model: string | null;
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
    model: v.model ?? null,
    submitted_at: v.created_at,
  };
}

export interface ReviewGateWire {
  reviewed: boolean;
  all_topics_passed: boolean;
  topics: Array<{
    topic: string | null;
    head_sha: string | null;
    state: S.ReviewTopicState;
    blocking_reason: S.ReviewBlockingReason | null;
  }>;
}

export function reviewGateJSON(gate: S.ReviewGate): ReviewGateWire {
  return {
    reviewed: gate.reviewed,
    all_topics_passed: gate.allTopicsPassed,
    topics: gate.topics.map((topic) => ({
      topic: topic.topic,
      head_sha: topic.headSha,
      state: topic.state,
      blocking_reason: topic.blockingReason,
    })),
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

export type InboxJsonPrimitive = string | number | boolean | null;
export type InboxJsonValue =
  | InboxJsonPrimitive
  | InboxJsonValue[]
  | { [key: string]: InboxJsonValue };
export type InboxJsonObject = { [key: string]: InboxJsonValue };

export interface InboxMessageWire {
  id: number;
  repo: { name: string };
  from: InboxJsonObject;
  to: InboxJsonObject | null;
  label: string | null;
  title: string;
  body: string;
  state: S.InboxMessageState;
  created_at: string;
}

function safeParseObject(raw: string | null): InboxJsonObject | null {
  if (raw == null) return null;
  try {
    const value = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as InboxJsonObject;
    }
  } catch {}
  return {};
}

export function inboxMessageJSON(m: S.InboxMessageRow): InboxMessageWire {
  const repo = S.getRepoById(m.repo_id);
  return {
    id: m.id,
    repo: { name: repo?.full_name ?? "" },
    from: safeParseObject(m.from_json) ?? {},
    to: safeParseObject(m.to_json),
    label: m.label ?? null,
    title: m.title,
    body: m.body,
    state: m.state,
    created_at: m.created_at,
  };
}

export interface NotificationWire {
  id: number;
  kind: S.NotificationKind;
  repo: { name: string };
  title: string;
  body: string;
  resource: {
    kind: S.NotificationResourceKind;
    number: number | null;
    href: string;
  };
  herdr_pane_id: string | null;
  read_at: string | null;
  created_at: string;
}

export function notificationJSON(n: S.NotificationRow): NotificationWire {
  const repo = S.getRepoById(n.repo_id);
  const repoName = repo?.full_name ?? "";
  let href = repo ? `/r/${repo.full_name}` : "";
  if (repo) {
    if (n.resource_kind === "pull" && n.resource_number != null) {
      href = `/r/${repo.full_name}/pulls/${n.resource_number}`;
    } else if (n.resource_kind === "issue" && n.resource_number != null) {
      href = `/r/${repo.full_name}/issues/${n.resource_number}`;
    } else {
      href = `/r/${repo.full_name}`;
    }
  }
  return {
    id: n.id,
    kind: n.kind,
    repo: { name: repoName },
    title: n.title,
    body: n.body,
    resource: {
      kind: n.resource_kind,
      number: n.resource_number,
      href,
    },
    herdr_pane_id: n.herdr_pane_id,
    read_at: n.read_at,
    created_at: n.created_at,
  };
}

export function labelJSON(l: S.LabelRow): LabelWire {
  return { name: l.name, color: l.color };
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
  const pull = S.getPull(pr.id)!;
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: !!pr.merged,
    draft: !!pull.draft,
    html_url: linkedRef(repo, "pulls", pr.number).html_url,
    // #629: the exported GitHub PR (if any), so the issue-detail linked-PR row can show a GH badge.
    github_pull: githubPullJSON(S.getGithubPull(pr.id)),
    // #863: whether this PR was force-stopped for exceeding its cost limit.
    cost_stopped: S.hasAnyCostStopEvent(repo.id, pr.number),
  };
}

// Git-derived status fields for a PR row: mergeable state, diff totals, the
// "working" flag, and review state. Shared by pullJSON (PR list/detail) and the
// issue list's linked-PR summary so both compute status identically. The git
// fan-out (revParse/mergePreview/diffStat/status) is bounded — callers keep
// their lists paginated.
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
    revParse(repo.local_path, p.head_ref),
    revParse(repo.local_path, p.base_ref),
    resolvePullBaseSha(repo.local_path, p),
  ]);
  // Prefer the live Git head for both display state and merge gate. The stored
  // watcher SHA is only a fallback when the ref cannot currently be resolved.
  // computeReviewStatus aggregates once per topic so these two signals cannot
  // disagree about a stale or changes-requested topic.
  const reviewStatus = S.computeReviewStatus(row.id, headSha ?? p.head_sha);
  let mergeable: boolean | null = null;
  let mergeable_state: MergeableState = "unknown";
  let commits_ahead = 0;
  if (!p.merged && headSha && baseSha) {
    const [prev, ahead, effectiveDiff] = await Promise.all([
      mergePreview(repo.local_path, p.base_ref, p.head_ref),
      commitsAhead(repo.local_path, p.base_ref, p.head_ref),
      hasEffectiveDiff(repo.local_path, p.base_ref, p.head_ref),
    ]);
    commits_ahead = ahead;
    ({ mergeable, mergeable_state } = resolveMergeable({
      hasEffectiveDiff: effectiveDiff,
      conflict: prev.conflict,
      reviewed: reviewStatus.gate.reviewed,
      allTopicsPassed: reviewStatus.gate.allTopicsPassed,
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
  // "working" badge: real uncommitted changes in this PR's lh-build worktree. Guarded so the
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
  // Path of the existing `lh build` worktree backing this PR (same convention as the
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
  return {
    number: pr.number,
    title: pr.title,
    state: pr.state,
    merged: !!pr.merged,
    draft: !!status.pull.draft,
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
  };
}

export function issueJSON(row: S.IssueRow, repo?: S.Repo): IssueWire {
  const out: IssueWire = {
    number: row.number,
    state: row.state,
    title: row.title,
    body: row.body,
    target_branch: row.target_branch ?? null,
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

export async function issueDetailJSON(
  row: S.IssueRow,
  repo: S.Repo,
): Promise<IssueWire> {
  const out = issueJSON(row, row.kind === "pull" ? repo : undefined);
  if (row.kind !== "pull") {
    const linked = S.allLinkedPullsForIssue(row.id);
    // Detail is the attempt-comparison surface, so every linked PR needs the
    // same comparison fields. List/dashboard paths remain capped separately.
    const pulls = await Promise.all(
      linked
        .slice(0, S.MAX_ISSUE_DETAIL_PULLS)
        .map((pr) => linkedPullDetail(repo, pr)),
    );
    out.linked_pull_requests = pulls;
    out.linked_pull_request = pulls[0] ?? null;
    out.linked_pull_requests_truncated =
      linked.length > S.MAX_ISSUE_DETAIL_PULLS;
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

// Runtime UI features exposed by lh-web. Keep this wire shape in core so the server and SPA cannot
// drift when new experimental surfaces are added.
export interface WebConfigWire {
  experimental: boolean;
}

export function webConfigJSON(experimental: boolean): WebConfigWire {
  return { experimental };
}

// A scheduled task (#880): a repo-scoped saved prompt a coding agent runs at one or more times of
// day. `times` is parsed back from the JSON column. `model`/`effort` are the stored overrides (null
// when unset); `default_model`/`default_effort` are the per-agent application defaults that apply
// when unset, so the UI can show them as placeholders without re-implementing config resolution.
export interface ScheduledTaskWire {
  id: number;
  title: string;
  prompt: string;
  agent: string;
  times: string[];
  model: string | null;
  effort: string | null;
  default_model: string;
  default_effort: string;
  created_at: string;
  updated_at: string;
}

export function scheduledTaskJSON(row: S.ScheduledTaskRow): ScheduledTaskWire {
  const agent = row.agent as CodingAgent;
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    agent: row.agent,
    times: safeParseArray<string>(row.times_json),
    model: row.model ?? null,
    effort: row.effort ?? null,
    default_model: agentModel(agent),
    default_effort: agentEffort(agent),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// One fire of a scheduled task (#880) — meta only; the agent's output stays on the herdr side.
// `trigger` is 'scheduled' | 'manual'; `status` is the launch outcome ('running' | 'success' |
// 'failure'); the herdr refs point at the launched tab/pane so a human can open the live output.
export interface ScheduledTaskRunWire {
  id: number;
  trigger: string;
  scheduled_time: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  herdr_tab_id: string | null;
  herdr_pane_id: string | null;
  error: string | null;
}

export function scheduledTaskRunJSON(
  row: S.ScheduledTaskRunRow,
): ScheduledTaskRunWire {
  return {
    id: row.id,
    trigger: row.trigger,
    scheduled_time: row.scheduled_time ?? null,
    started_at: row.started_at,
    ended_at: row.ended_at ?? null,
    status: row.status,
    herdr_tab_id: row.herdr_tab_id ?? null,
    herdr_pane_id: row.herdr_pane_id ?? null,
    error: row.error ?? null,
  };
}

// A workflow definition (#997): a global prompt bundle for the fixed
// Execute/Verify workflow. Prompt strings are plain markdown and may be empty.
export interface WorkflowWire {
  id: number;
  name: string;
  description: string;
  execute_prompt: string;
  verify_prompt: string;
  created_at: string;
  updated_at: string;
}

export function workflowJSON(row: S.WorkflowRow): WorkflowWire {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    execute_prompt: row.execute_prompt,
    verify_prompt: row.verify_prompt,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Fixed system prompts for the workflow steps, sourced from their launch-time contracts. */
export interface WorkflowStepContractsWire {
  execute: string;
  verify: string;
}

// Workflow run display state (#1008): the current step / status / rework count of the run linked to an
// issue or PR, for issue / PR detail. The run row is the display-state source (workflow design:
// CLI / UI) — the
// *truth* of step completion stays with `workflow step status` (HEAD vs the pinned review), which
// this wire deliberately does not re-derive. `latest_review` surfaces the human-readable reason
// behind a rework / block; the web derives the issue-comment / inbox links from `issue_number`.
export interface WorkflowRunReviewSummaryWire {
  id: number;
  event: "pass" | "request_changes";
  summary: string;
  findings_count: number;
}

export interface WorkflowRunStateWire {
  id: number;
  workflow_id: number | null;
  workflow_name: string | null;
  status: string; // running | completed | stopped (legacy terminal rows may still read 'blocked')
  current_step: string; // execute | verify
  rework_count: number;
  // Non-null while the run waits for an explicit human instruction (#1307). The run stays
  // `running` (active + resumable); the UI renders this as a Needs human state.
  needs_human_reason: string | null;
  issue_number: number;
  pr_number: number;
  created_at: string;
  updated_at: string;
  latest_review: WorkflowRunReviewSummaryWire | null;
}

export function workflowRunStateJSON(input: {
  run: S.WorkflowRunRow;
  workflowName: string | null;
  latestReview: WorkflowRunReviewSummaryWire | null;
}): WorkflowRunStateWire {
  const { run } = input;
  return {
    id: run.id,
    workflow_id: run.workflow_id,
    workflow_name: input.workflowName,
    status: run.status,
    current_step: run.current_step,
    rework_count: run.rework_count,
    needs_human_reason: run.needs_human_reason,
    issue_number: run.issue_number,
    pr_number: run.pr_number,
    created_at: run.created_at,
    updated_at: run.updated_at,
    latest_review: input.latestReview,
  };
}

/** One persisted lifecycle event shown in a Workflow run's history dialog. */
export interface WorkflowRunHistoryEventWire {
  id: number;
  type: string;
  label: string;
  description: string;
  input: string | null;
  step: string | null;
  actor: string;
  created_at: string;
}

function workflowStepLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function workflowEventPayload(row: S.EventRow): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.payload);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Normalize stored event payloads into stable, reader-facing timeline entries. */
export function workflowRunHistoryEventJSON(
  row: S.EventRow,
  input: string | null = null,
): WorkflowRunHistoryEventWire {
  const payload = workflowEventPayload(row);
  const step =
    typeof payload.step === "string"
      ? payload.step
      : typeof payload.current_step === "string"
        ? payload.current_step
        : null;
  const stepLabel = workflowStepLabel(step);
  let label = row.type
    .replace(/^workflow_/u, "")
    .replace(/[._-]+/gu, " ")
    .replace(/^./u, (value) => value.toUpperCase());
  let description = "Workflow lifecycle event recorded.";

  if (row.type === "workflow_run.started") {
    label = "Run started";
    description = `Workflow run #${String(payload.id ?? "")} started.`;
  } else if (row.type === "workflow_run.updated") {
    const status =
      typeof payload.status === "string" ? payload.status : "updated";
    const transition =
      typeof payload.transition === "string" ? payload.transition : null;
    // `needs_human_reason` is present in the payload only when the update touched the human wait
    // (#1307): a string marks the escalation, an explicit null marks the human-instructed resume.
    const touchedNeedsHuman = "needs_human_reason" in payload;
    const needsHumanReason =
      typeof payload.needs_human_reason === "string"
        ? payload.needs_human_reason
        : null;
    label =
      status === "completed"
        ? "Run completed"
        : status === "stopped"
          ? "Run stopped"
          : status === "blocked"
            ? "Run blocked"
            : touchedNeedsHuman
              ? needsHumanReason !== null
                ? "Run needs human"
                : "Run resumed"
              : transition === "advance_to_verify"
                ? "Run advanced to Verify"
                : transition === "request_rework"
                  ? "Run rework requested"
                  : "Run state updated";
    const details = [
      `Status: ${workflowStepLabel(status) ?? status}.`,
      touchedNeedsHuman
        ? needsHumanReason !== null
          ? `Waiting for a human: ${needsHumanReason}`
          : "Human wait cleared; the run may progress again."
        : null,
      stepLabel ? `Current step: ${stepLabel}.` : null,
      typeof payload.rework_count === "number"
        ? `Rework count: ${payload.rework_count}.`
        : null,
    ].filter((value): value is string => value !== null);
    description = details.join(" ");
  } else if (row.type === "workflow_step.launched") {
    label = `${stepLabel ?? "Workflow"} step started`;
    description = `${stepLabel ?? "Workflow"} step execution started.`;
  } else if (row.type === "workflow_run.turn_done") {
    label = "Turn done declared";
    description =
      "Execute declared its turn done. The parent observes HEAD and review state before any transition.";
  }

  return {
    id: row.id,
    type: row.type,
    label,
    description,
    input,
    step,
    actor: row.actor,
    created_at: row.created_at,
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
// session's start (agent_sessions.created_at — set once at `lh build`/`sessions.register` and never
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
  // Exact fork point captured at PR creation; legacy rows infer it from git merge-base.
  base_sha: string | null;
  merged: boolean;
  // draft (#413): true while the PR is WIP (opened by `lh build` at the start of work);
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
  review_gate: ReviewGateWire;
  changes_addressed_at: string | null;
  changes_addressed_by: string | null;
  labels: LabelWire[];
  comments: number;
  created_at: string;
  updated_at: string;
  linked_issue: LinkedIssueWire | null;
  worktree_path: string | null;
  // #863: the PR has at least one `dev.cost_stopped` event — its dev agent was force-stopped for
  // exceeding the cost limit. Drives the "cost stopped" badge on the PR list row and detail header.
  cost_stopped: boolean;
  // #406: the effective write action for this PR ('merge' | 'github_pr') and the GitHub PR it was
  // exported to (null until the export skill records one). The UI swaps Merge ⟷ Create/View PR.
  merge_mode: MergeMode;
  github_pull: GithubPullWire | null;
  // Detail-only: commits on head not reachable from base (base..head), newest first. Omitted from
  // list responses so their bounded pagination does not add one git log per row.
  commits?: PullCommitWire[];
  // Detail-only (#298, #456): the PR's related sessions, aggregate usage, and derived work
  // duration. Gated so the PR list/dashboard stay O(1) git + no extra per-row query.
  related_sessions?: RelatedSessionWire[];
  related_sessions_usage?: RelatedSessionsUsageWire;
  work_duration?: PullWorkDuration;
}

export interface PullCommitWire {
  sha: string;
  author: string;
  date: string;
  subject: string;
  // Detail-only, and present only when a linked GitHub PR has a recorded pushed SHA that still
  // belongs to the current PR history. False means this current-history commit is locally ahead.
  pushed_to_github?: boolean;
}

export async function pullJSON(
  repo: S.Repo,
  row: S.IssueRow,
  opts: { withCommits?: boolean; withRelatedSessions?: boolean } = {},
): Promise<PullWire> {
  const p = S.getPull(row.id)!;
  const status = await pullStatusFields(repo, row);
  const [mergeFields, commits] = await Promise.all([
    pullMergeFields(repo, row.id),
    opts.withCommits
      ? status.headSha && status.baseSha
        ? commitLog(repo.local_path, p.base_ref, p.head_ref)
        : []
      : undefined,
  ]);
  const pushedShas =
    commits !== undefined &&
    status.headSha &&
    status.baseSha &&
    mergeFields.github_pull?.pushed_sha
      ? await pushedCommitShas(
          repo.local_path,
          p.base_ref,
          p.head_ref,
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
    // draft (#413): true while the PR is WIP (opened by `lh build` at the start of work);
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
    review_gate: status.review_gate,
    changes_addressed_at: p.changes_addressed_at ?? null,
    changes_addressed_by: p.changes_addressed_by ?? null,
    labels: S.issueLabels(row.id).map(labelJSON),
    comments: S.countComments(row.id),
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
    ...(commitsWithPushState !== undefined
      ? { commits: commitsWithPushState }
      : {}),
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
