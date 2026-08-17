// JSON serializers: shape store rows into the stable wire objects that consumers
// (CLI now, JSON-RPC clients later) read. Kept separate from service.ts so the
// shaping is reusable and side-effect free. Every function here is synchronous and
// derives its output from the rows it is given (plus store lookups) — the serializers
// whose values come from live git / worktree state live in serialize-status.ts, so this
// module needs neither node:fs nor core/git.ts and is testable without a git repo.

import { resolveEffectiveAgentConfig } from "./config.ts";
import type { GhPrStatus, GithubReviewState } from "./github.ts";
import { linkedRef } from "./links.ts";
import type { MergeMode } from "./merge-mode.ts";
import type { MergeableState } from "./mergeable.ts";
import type { EffectiveAgentConfig } from "./repo-agent-config.ts";
import { normalizeRepoAgentRuntime } from "./repo-agent-config.ts";
import type { CodingAgent } from "./runtimes.ts";
import * as S from "./store.ts";
import type {
  HerdrAgent,
  HerdrIssueWorkspace,
  HerdrPullWorkspace,
} from "./terminal/herdr-status.ts";
import { herdrSessionName } from "./terminal/terminal-launch.ts";
import type { Theme } from "./theme.ts";
import {
  type WorkerCompatibility,
  type WorkerRuntimeRecord,
  workerCompatibility,
} from "./worker-protocol.ts";
import type { WorkflowContractLanguage } from "./workflow/contracts.ts";
import {
  parseWorkflowEventPayload,
  type StoredWorkflowEventPayload,
} from "./workflow/event-payloads.ts";
import type { WorkflowHerdrAgent } from "./workflow/herdr-agents.ts";
import type { WorkflowStepStatuses } from "./workflow/steps.ts";

// Wire-type SSOT (AGENTS.md): the coding-runtime id is part of several wire shapes below (agent cost
// summary and per-agent settings). Re-export it from the registry so web/src/api/types.ts derives
// `CodingAgent` from core via a type-only import instead of re-declaring the union.
export type { CodingAgent } from "./runtimes.ts";
export type { Theme as ThemeWire } from "./theme.ts";
export type { WorkflowContractLanguage as WorkflowContractLanguageWire } from "./workflow/contracts.ts";

export type WorkerCompatibilityWire = WorkerCompatibility;

export function workerCompatibilityJSON(
  runtime: WorkerRuntimeRecord | null,
  nowMs = Date.now(),
): WorkerCompatibilityWire {
  return workerCompatibility(runtime, nowMs);
}

export interface AgentSettingsWire {
  model: string;
  effort: string;
}

export interface GlobalSettingsWire {
  agents: Record<CodingAgent, AgentSettingsWire>;
  codingAgent: CodingAgent;
  devCostLimitUsd: number;
  // Whether the Web UI rings a bell for new notifications (#2508).
  notificationSound: boolean;
  theme: Theme | null;
  workflowContractLanguage: WorkflowContractLanguage;
}

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

// #71: how the registered checkout stands against its `origin` remote, for the repo-top sidebar.
// `has_origin` false means the repo has no origin at all and the sidebar hides the sync UI.
// `branch` is null on a detached HEAD; `ahead`/`behind` are null when the branch has no
// `origin/<branch>` yet (never pushed), which is not the same as being level with it. The counts
// come from the remote-tracking ref as it stands locally — reading them does not contact origin.
export interface RepoOriginSyncWire {
  has_origin: boolean;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
}

// #1532: resolved per-repo Coding agent override for the repo settings UI — the raw stored setting
// (toggle + runtime/model/effort as entered) and the effective config the run launches with (repo
// override when on, else the application defaults). Same "raw stored vs resolved effective" shape as
// RepoMergeModeWire.
export interface RepoAgentConfigWire {
  setting: {
    override: boolean;
    runtime: CodingAgent | null;
    model: string | null;
    effort: string | null;
  };
  effective: {
    runtime: CodingAgent;
    model: string;
    effort: string;
  };
}

// #2422: per-repo additional text for the "Create PR on GitHub" agent prompt. Null means unset —
// launches use only the default template.
export interface RepoGithubPrExportExtraPromptWire {
  extra_prompt: string | null;
}

export interface WorkspaceWire {
  branch: string;
  created_at: string;
  archived_at: string | null;
  branch_exists: boolean;
}

export interface WorkspaceResolutionWire {
  repo: RepoWire;
  workspace: WorkspaceWire;
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

// #1532: the effective coding-agent config a workflow run on this repo launches with — the repo
// override when its toggle is on, else the application config.json defaults. Shared by the repo
// settings view (repoAgentConfigJSON) and the workflow-run launch path (runModel fallback).
export function effectiveRepoAgentConfigFor(r: S.Repo): EffectiveAgentConfig {
  return resolveEffectiveAgentConfig({
    override: r.agent_override === 1,
    runtime: normalizeRepoAgentRuntime(r.agent_runtime),
    model: r.agent_model ?? null,
    effort: r.agent_effort ?? null,
  });
}

export function repoGithubPrExportExtraPromptJSON(
  r: S.Repo,
): RepoGithubPrExportExtraPromptWire {
  const raw = r.github_pr_export_extra_prompt;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return { extra_prompt: trimmed === "" ? null : trimmed };
}

export function repoAgentConfigJSON(r: S.Repo): RepoAgentConfigWire {
  return {
    setting: {
      override: r.agent_override === 1,
      runtime: normalizeRepoAgentRuntime(r.agent_runtime),
      model: r.agent_model ?? null,
      effort: r.agent_effort ?? null,
    },
    effective: effectiveRepoAgentConfigFor(r),
  };
}

export interface UserWire {
  login: string;
}

export interface SearchSnippetSegmentWire {
  text: string;
  match: boolean;
}

export interface SearchSnippetWire {
  field: "title" | "body";
  segments: SearchSnippetSegmentWire[];
}

export interface SearchResultWire {
  kind: "issue" | "pull";
  number: number;
  title: string;
  state: "open" | "closed";
  snippet: SearchSnippetWire | null;
}

export function searchResultJSON(row: S.SearchResultRow): SearchResultWire {
  return {
    kind: row.kind,
    number: row.number,
    title: row.title,
    state: row.state,
    snippet: row.snippet,
  };
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
  model?: string;
  effort?: string;
  usage?: SessionUsageWire[];
  subagent_usage?: SessionSubagentUsageWire[];
  linked_targets?: SessionLinkedTargetWire[];
}

export interface AgentCostSummaryWire {
  agent: CodingAgent;
  month: number | null;
  week: number | null;
  day: number | null;
}

export interface RelatedSessionWire extends AgentSessionWire {
  linked_at: string | null;
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
  // Detail/list enrichment: commits added to the current base since this PR forked.
  base_commits_behind?: number;
  // #863: the PR has at least one `dev.cost_stopped` event — its dev agent was force-stopped for
  // exceeding the cost limit. Drives the "cost stopped" badge on every surface that shows the PR.
  cost_stopped: boolean;
}

// #2263: the agent-cost slice of a PR on its own. `agent_session.usage_updated` is the app's
// highest-frequency event, and the payloads carrying these two fields (issue detail / PR detail)
// are built from live git — so the slice gets its own query key and RPC, and the git-backed
// payloads are left to the events that actually change them.
export type PullUsageWire = Pick<
  PullSummaryWire,
  "number" | "total_tokens" | "cost_usd"
>;

// Extra fields present only on the issue-list linked-PR sub-row (issueListItemJSON's
// linkedPullDetail), which runs the git status fan-out; the issue-detail summary
// (pullSummary) does not, so those rows stay the plain PullSummaryWire.
export interface IssueListPullSummaryWire extends PullSummaryWire {
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
  // #2147: how many Execute -> Verify loops the PR's latest workflow run has taken, so an issue
  // list shows a PR that keeps circling without opening its run. Omitted when no workflow run is
  // linked to the PR; zero means a linked run that has not reworked yet.
  workflow_rework_count?: number;
  // #2152: comments on the PR for the sub-row — its conversation comments plus every diff-comment
  // message, as one total. Zero when the PR has neither.
  total_comments: number;
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

export interface SubIssueSummaryWire {
  total: number;
  open: number;
  closed: number;
}

export interface IssueRefSummaryWire {
  number: number;
  title: string;
  state: "open" | "closed";
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
  archived_pull_requests?: PullSummaryWire[];
  archived_pull_requests_truncated?: boolean;
  has_open_pull_request: boolean;
  github_issue?: GithubIssueWire | null;
  // Structured acceptance criteria (enabled only), display order (#1894). Detail response only.
  // This is the rubric source for Verify — the markdown `## Acceptance criteria` section is never
  // parsed. Absent on issues that have no structured criteria (they fall back to holistic Verify).
  acceptance_criteria?: AcceptanceCriterionWire[];
  depth?: number;
  sub_issue_ordinal?: number | null;
  sub_issue_summary?: SubIssueSummaryWire;
  ancestors?: IssueRefSummaryWire[];
  sub_issues?: IssueWire[];
  sub_issues_truncated?: boolean;
}

// The rubric-delivery shape carried on issue view. `id` is the public, repository-scoped
// `<issue-number>-<ac-number>` reference accepted by review submission; the database row id stays
// off the wire. Only enabled criteria reach this shape, so no `enabled` field is needed.
export interface AcceptanceCriterionWire {
  id: string;
  number: number;
  ordinal: number;
  text: string;
}

// The authoring shape returned by the `lh issue ac` commands and the Web management RPC, which must
// show disabled criteria (so an operator can re-enable them) — hence the extra `enabled`.
export interface AcceptanceCriterionDetailWire {
  id: string;
  number: number;
  ordinal: number;
  text: string;
  enabled: boolean;
}

export function acceptanceCriterionDisplayId(
  issueNumber: number,
  criterionNumber: number,
): string {
  return `${issueNumber}-${criterionNumber}`;
}

export type DiffFeedbackFreshness = "current" | "outdated" | "unavailable";
export type DiffFeedbackSide = "LEFT" | "RIGHT";
export type DiffFeedbackOutdatedReason = "deleted" | "modified" | "ambiguous";
export type DiffFeedbackPlacement = "inline" | "historical";

export interface PullDiffWire {
  base_sha: string;
  head_sha: string;
  files: {
    path: string;
    absolute_path: string;
    original_path: string | null;
    status: string;
    additions: number;
    deletions: number;
    patch: string;
    lines: {
      kind: "hunk" | "context" | "addition" | "deletion" | "meta";
      text: string;
      left_line: number | null;
      right_line: number | null;
    }[];
  }[];
}

export interface DiffFeedbackMessageWire {
  id: number;
  thread_id: number;
  author: string;
  author_type: S.CommentAuthorType;
  body: string;
  created_at: string;
  reactions: DiffFeedbackReactionWire[];
}

export interface ReactionWire {
  emoji: string;
  count: number;
  reacted: boolean;
}

export type DiffFeedbackReactionWire = ReactionWire;

export interface DiffFeedbackThreadWire {
  id: number;
  pr_number: number;
  anchor: {
    base_sha: string;
    head_sha: string;
    path: string;
    original_path: string | null;
    side: DiffFeedbackSide;
    start_line: number;
    end_line: number;
  };
  /** Current diff coordinates derived from the immutable anchor, present only when current. */
  resolved_anchor: {
    path: string;
    original_path: string | null;
    side: DiffFeedbackSide;
    start_line: number;
    end_line: number;
  } | null;
  freshness: DiffFeedbackFreshness;
  outdated_reason: DiffFeedbackOutdatedReason | null;
  /** Where the current diff viewer should render the conversation. */
  placement: DiffFeedbackPlacement;
  /** Context from the persisted commit pair, retained even when the anchor cannot be relocated. */
  original_context: DiffFeedbackContextLineWire[] | null;
  /** When set, the conversation is kept but shown collapsed and stays out of pending feedback. */
  archived_at: string | null;
  created_by: string;
  created_by_type: S.CommentAuthorType;
  created_at: string;
  messages: DiffFeedbackMessageWire[];
}

export interface DiffFeedbackListWire {
  threads: DiffFeedbackThreadWire[];
  comment_counts: Record<string, number>;
}

/**
 * One diff line around a thread's anchor. Same coordinates as `PullDiffWire`, plus which lines the
 * anchor itself selected, so a reader without the diff on screen can tell them apart.
 */
export interface DiffFeedbackContextLineWire {
  kind: "hunk" | "context" | "addition" | "deletion" | "meta";
  text: string;
  left_line: number | null;
  right_line: number | null;
  anchored: boolean;
}

/** A thread plus the diff context an agent needs to act on it without rendering the whole file. */
export interface DiffFeedbackThreadDetailWire extends DiffFeedbackThreadWire {
  /** Current context when resolved, otherwise the original historical context. */
  context: DiffFeedbackContextLineWire[] | null;
}

export interface DiffFeedbackPendingWire {
  run: number;
  threads: DiffFeedbackThreadDetailWire[];
}

export function pullFileViewJSON(row: S.PullFileViewRow): PullFileViewWire {
  return { path: row.path, sha: row.sha, viewed_at: row.created_at };
}

export function diffFeedbackMessageJSON(
  row: S.DiffFeedbackMessageRow,
  reactions: S.DiffFeedbackReactionRow[] = [],
  actor?: string,
): DiffFeedbackMessageWire {
  const counts = new Map<string, { count: number; reacted: boolean }>();
  for (const reaction of reactions) {
    const current = counts.get(reaction.emoji);
    counts.set(reaction.emoji, {
      count: (current?.count ?? 0) + 1,
      reacted: current?.reacted === true || reaction.author === actor,
    });
  }
  return {
    id: row.id,
    thread_id: row.thread_id,
    author: row.author,
    author_type: row.author_type,
    body: row.body,
    created_at: row.created_at,
    reactions: Array.from(counts, ([emoji, reaction]) => ({
      emoji,
      ...reaction,
    })),
  };
}

export function acceptanceCriterionJSON(
  row: S.AcceptanceCriterionRow,
  issueNumber: number,
): AcceptanceCriterionWire {
  return {
    id: acceptanceCriterionDisplayId(issueNumber, row.number),
    number: row.number,
    ordinal: row.ordinal,
    text: row.text,
  };
}

export function acceptanceCriterionDetailJSON(
  row: S.AcceptanceCriterionRow,
  issueNumber: number,
): AcceptanceCriterionDetailWire {
  return {
    id: acceptanceCriterionDisplayId(issueNumber, row.number),
    number: row.number,
    ordinal: row.ordinal,
    text: row.text,
    enabled: row.enabled === 1,
  };
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
  // When this link was recorded. Sourced from the export record's linked_at, not its created_at:
  // since #2383 the record is opened when the export *starts*, and this field has always meant the
  // link's own first-seen time.
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
    created_at: g.linked_at,
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
  if (row.model) out.model = row.model;
  if (row.effort) out.effort = row.effort;
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

// One entry in a PR/issue's "related sessions" list (#298). Existing session metadata, including
// the external runtime session id exposed as `session`, remains readable.
export function relatedSessionJSON(
  row: S.LinkedAgentSessionRow,
): RelatedSessionWire {
  return { ...agentSessionJSON(row), linked_at: row.linked_at ?? null };
}

// The full related-sessions list for an issues row (issue or PR), newest link first.
export function relatedSessionsJSON(
  containerRow: S.IssueRow,
): RelatedSessionWire[] {
  return S.listSessionsForIssue(containerRow.id).map(relatedSessionJSON);
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
  // Set only on a group carried over from an earlier snapshot because this repo's `agent list`
  // capture failed (#2142): the ISO time of the last capture that actually produced this group.
  // Absent means the group is this tick's live capture.
  stale_since?: string;
}

export interface HerdrSessionsWire {
  repos: HerdrRepoSessionsWire[];
  running_repos?: string[];
  // Set when the top-level `herdr session list` capture failed. `repos` and `running_repos` are the
  // last successful values when available, so clients can keep rendering them while making the
  // failure explicit. Absent after the next successful capture.
  session_list_capture_failed?: true;
  // Repos whose `herdr agent list` capture failed on the tick that wrote this snapshot (#2142).
  // Their `repos` entry — when one was already known — is the carried-over group tagged with
  // `stale_since`; a repo listed here with no `repos` entry never captured successfully. Absent
  // when every running repo captured, so "no agents" and "capture failed" stay distinguishable.
  capture_failed_repos?: string[];
  // When lh-worker last wrote this snapshot (ISO). The `terminal/sessions` RPC is a pure DB read of
  // the worker-owned snapshot (#1665), so a stopped worker leaves this timestamp frozen — clients
  // surface the staleness instead of an automatic herdr fallback that would hide the stopped worker.
  // Null when no snapshot has ever been written (worker never ran, or a fresh DB).
  captured_at?: string | null;
}

export type TerminalLaunchBackendWire = "builtin" | "herdr";

// Result of `terminal/launch`: which backend handled it plus the herdr coordinates the client
// surfaces (session_name / command / cwd / attach).
export interface TerminalLaunchResultWire {
  backend: TerminalLaunchBackendWire;
  session_name?: string;
  command?: string;
  cwd?: string;
  attach?: string;
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
  author_type: S.CommentAuthorType;
  body: string;
  created_at: string;
  reactions: ReactionWire[];
  /** When set, the comment is kept but shown collapsed. */
  archived_at: string | null;
}

export function commentJSON(
  m: S.CommentRow,
  reactions: S.CommentReactionRow[] = [],
  actor?: string,
): CommentWire {
  const counts = new Map<string, { count: number; reacted: boolean }>();
  for (const reaction of reactions) {
    const current = counts.get(reaction.emoji);
    counts.set(reaction.emoji, {
      count: (current?.count ?? 0) + 1,
      reacted: current?.reacted === true || reaction.author === actor,
    });
  }
  return {
    id: m.id,
    user: { login: m.author },
    author_type: m.author_type,
    body: m.body,
    created_at: m.created_at,
    reactions: Array.from(counts, ([emoji, reaction]) => ({
      emoji,
      ...reaction,
    })),
    archived_at: m.archived_at,
  };
}

// One per-criterion grade attached to a review (#1895), derived from `review_ac_results` joined to
// `acceptance_criteria` for the rubric text. Empty for a holistic review (no structured grading).
export interface ReviewAcResultWire {
  criterion_id: string;
  number: number;
  text: string;
  verdict: "pass" | "fail";
  note: string;
}

export interface ReviewWire {
  id: number;
  user: UserWire;
  author_type: S.CommentAuthorType;
  // Not narrowed to "PASS" | "REQUEST_CHANGES" | "COMMENT" | "FEEDBACK": reviews.create
  // (core/service/reviews.ts) only special-cases "APPROVE" -> "PASS" and otherwise stores the
  // caller's uppercased string verbatim, so the wire value isn't actually guaranteed to be one of
  // the known events. FEEDBACK (#1674) is the non-blocking human feedback type.
  state: string;
  body: string;
  // The commit this review was made against (lets clients group reviews by
  // commit, e.g. #208); may be null.
  head_sha: string | null;
  // The agent/model that produced the review (#1107); null when unattributed.
  model: string | null;
  submitted_at: string;
  // How long the review took (#2387): the reviewing session's start → this submission. Null when
  // it cannot be derived — see reviewDurationSeconds.
  duration_seconds: number | null;
  // Per-criterion rubric grades this review recorded (#1897); empty when it graded no structured
  // criteria (holistic fallback). The caller joins them rather than reviewJSON.
  ac_results: ReviewAcResultWire[];
}

// How long the review took (#2387), measured from the start of the session that submitted it
// (agent_sessions.created_at — the same stable start marker pullWorkDuration anchors to) to the
// review's own submission. A reviewing session exists to produce its review, so this covers the
// whole review: reading the diff, exploring the code, grading. It is not split per review if one
// session ever posts several — the second would report the time since the session began.
//
// Returns null when there is nothing to measure — no recorded session (human/manual submission, or
// a review predating the column), a session row that has since gone, or an unusable pair of
// timestamps. Callers show nothing in that case rather than 0 or a guess.
export function reviewDurationSeconds(v: S.ReviewRow): number | null {
  if (!v.session_id) return null;
  const session = S.getAgentSession(v.session_id);
  if (!session) return null;
  const startedAt = Date.parse(session.created_at);
  const submittedAt = Date.parse(v.created_at);
  if (Number.isNaN(startedAt) || Number.isNaN(submittedAt)) return null;
  const seconds = Math.round((submittedAt - startedAt) / 1000);
  // Zero is not a measurement: `now()` has one-second resolution, so it means "submitted within
  // the same second the session was registered", not "took no time" — and a negative span is
  // simply unusable. Both report unknown, so no caller ever renders "0s" (#2387 AC 3).
  return seconds > 0 ? seconds : null;
}

export function reviewJSON(
  v: S.ReviewRow,
  acResults: ReviewAcResultWire[],
): ReviewWire {
  return {
    id: v.id,
    user: { login: v.author },
    author_type: v.author_type,
    state: v.event,
    body: v.body,
    head_sha: v.head_sha ?? null,
    model: v.model ?? null,
    submitted_at: v.created_at,
    duration_seconds: reviewDurationSeconds(v),
    ac_results: acResults,
  };
}

export interface ReviewGateWire {
  reviewed: boolean;
  passed: boolean;
  head_sha: string | null;
  blocking_reason: S.ReviewBlockingReason | null;
}

export function reviewGateJSON(gate: S.ReviewGate): ReviewGateWire {
  return {
    reviewed: gate.reviewed,
    passed: gate.passed,
    head_sha: gate.headSha,
    blocking_reason: gate.blockingReason,
  };
}

export interface ReviewCommentWire {
  id: number;
  pull_request_review_id: number | null;
  user: UserWire;
  author_type: S.CommentAuthorType;
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
    author_type: m.author_type,
    path: m.path,
    line: m.line,
    side: m.side,
    body: m.body,
    created_at: m.created_at,
  };
}

export interface ReviewDetailWire {
  review: ReviewWire;
  comments: ReviewCommentWire[];
}

export interface ReviewResponseWire {
  id: number;
  pull_request_review_id: number;
  pull_request_review_comment_id: number | null;
  user: UserWire;
  body: string;
  created_at: string;
}

export function reviewResponseJSON(m: S.ReviewResponseRow): ReviewResponseWire {
  return {
    id: m.id,
    pull_request_review_id: m.review_id,
    pull_request_review_comment_id: m.review_comment_id,
    user: { login: m.author },
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

export interface NotificationWire {
  id: number;
  kind: S.NotificationKind;
  severity: S.NotificationSeverity;
  repo: { name: string };
  title: string;
  body: string;
  resource: {
    kind: S.NotificationResourceKind;
    number: number | null;
    title: string | null;
    href: string;
  };
  herdr_pane_id: string | null;
  /** The Workflow run this notification is about, or null when it is not run-scoped. */
  workflow_run_id: number | null;
  read_at: string | null;
  created_at: string;
}

export function notificationJSON(n: S.NotificationRow): NotificationWire {
  const repo = S.getRepoById(n.repo_id);
  const repoName = repo?.full_name ?? "";
  const resourceTitle =
    repo && n.resource_kind !== "repo" && n.resource_number != null
      ? (S.getIssue(repo.id, n.resource_number)?.title ?? null)
      : null;
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
    severity: n.severity,
    repo: { name: repoName },
    title: n.title,
    body: n.body,
    resource: {
      kind: n.resource_kind,
      number: n.resource_number,
      title: resourceTitle,
      href,
    },
    herdr_pane_id: n.herdr_pane_id,
    workflow_run_id: n.workflow_run_id,
    read_at: n.read_at,
    created_at: n.created_at,
  };
}

export function labelJSON(l: S.LabelRow): LabelWire {
  return { name: l.name, color: l.color };
}

// Kind of one reference in a Markdown body, so a renderer can link the reference to the
// canonical issue or pull route instead of a resolver that redirects after a lookup. `repo`
// is the "owner/name" the reference points at — the rendering repo for `#n`, another one for
// `owner/repo#n` — echoed exactly as the caller asked for it, so a result maps back onto the
// reference that produced it.
export interface IssueRefKindWire {
  repo: string;
  number: number;
  kind: "issue" | "pull";
}

export function issueRefKindJSON(
  repo: string,
  row: S.IssueKindRow,
): IssueRefKindWire {
  return { repo, number: row.number, kind: row.kind };
}

// Summary of the issue a PR closes (pull-detail `linked_issue`).
export interface LinkedIssueWire {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
}

export function linkedIssueSummary(
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
    // #863: whether this PR was force-stopped for exceeding its cost limit.
    cost_stopped: S.hasAnyCostStopEvent(repo.id, pr.number),
  };
}

// #2263: the same tokens/cost pullSummary carries, served on its own so a usage tick refreshes the
// numbers without rebuilding a git-backed payload around them. Omitted rather than zeroed when no
// linked session has usage yet, matching the summary fields it stands in for.
export function pullUsageJSON(row: S.IssueRow): PullUsageWire {
  const totals = S.sessionUsageTotalsForIssue(row.id);
  return {
    number: row.number,
    ...(totals
      ? { total_tokens: totals.total_tokens, cost_usd: totals.cost_usd }
      : {}),
  };
}

export function issueJSON(
  row: S.IssueRow,
  repo?: S.Repo,
  selected?: { labels: S.LabelRow[]; comments: number },
): IssueWire {
  const out: IssueWire = {
    number: row.number,
    state: row.state,
    title: row.title,
    body: row.body,
    target_branch: row.target_branch ?? null,
    user: { login: row.author },
    labels: (selected?.labels ?? S.issueLabels(row.id)).map(labelJSON),
    comments: selected?.comments ?? S.countComments(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_open_pull_request: false,
  };
  if (row.kind === "pull") out.pull_request = { url: `/pulls/${row.number}` };
  else if (repo) {
    const pulls = linkedPullSummaries(repo, row.id);
    out.linked_pull_requests = pulls;
    out.linked_pull_request = pulls[0] ?? null;
    out.has_open_pull_request = pulls.some((pull) => pull.state === "open");
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
// drift when runtime controls are added.
export interface WebConfigWire {
  debug: boolean;
}

export function webConfigJSON(debug: boolean): WebConfigWire {
  return { debug };
}

export type WorkflowScopeWire =
  | { kind: "global" }
  | {
      kind: "repository";
      repo: { id: number; owner: string; name: string };
    };

// A workflow definition (#997): a global or repository-scoped prompt bundle for the fixed
// Execute/Verify workflow. Prompt strings are plain markdown and may be empty.
export interface WorkflowWire {
  id: number;
  name: string;
  description: string;
  execute_prompt: string;
  verify_prompt: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  scope: WorkflowScopeWire;
}

export function workflowJSON(row: S.WorkflowRow): WorkflowWire {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    execute_prompt: row.execute_prompt,
    verify_prompt: row.verify_prompt,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    scope:
      row.repo_id === null
        ? { kind: "global" }
        : {
            kind: "repository",
            repo: {
              id: row.repo_id,
              owner: row.repo_owner!,
              name: row.repo_name!,
            },
          },
  };
}

/**
 * Fixed system prompts of a workflow run, sourced from their launch-time contracts. `parent` is the
 * orchestration contract; only the two step prompts pair with a configurable prompt.
 */
export interface WorkflowContractsWire {
  parent: string;
  execute: string;
  verify: string;
}

// Workflow run display state (#1008): the current step / status / rework count of the run linked to an
// issue or PR, for issue / PR detail. Lifecycle comes from the run row; verification freshness is
// derived from the PR current HEAD and the pinned review rather than persisted on the run.
// `latest_review` surfaces the human-readable reason behind a rework / block; the web derives the
// issue-comment links from `issue_number`.
export interface WorkflowRunReviewSummaryWire {
  id: number;
  event: "pass" | "request_changes";
  summary: string;
  findings_count: number;
  // Per-criterion rubric grades for this review (#1895); empty when the review graded no structured
  // criteria (holistic fallback).
  ac_results: ReviewAcResultWire[];
}

export interface WorkflowStepExecutionWire {
  step: "execute" | "verify";
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  status: "running" | "completed" | "unknown";
  result: string | null;
  runtime: string | null;
  model: string | null;
  effort: string | null;
  input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  cost_status: "known" | "unknown" | "pending" | "not_recorded";
}

export interface WorkflowRunStateWire {
  id: number;
  workflow_id: number | null;
  workflow_name: string | null;
  status: string; // running | completed (closed PR); legacy rows may read 'stopped' or 'blocked'
  current_step: string; // execute | verify
  display_stage?: "execute" | "verify" | "ready_to_merge" | "merged";
  active_verify_head_sha: string | null;
  // When the active Verify launch began, read from its `workflow_step.launched` event's
  // `created_at` (#90). Present together with `active_verify_head_sha`; the Web derives the
  // elapsed reviewing time from it instead of `updated_at`, which advances on every event.
  active_verify_started_at: string | null;
  rework_count: number;
  rework_limit: number;
  rework_limit_increase_available: boolean;
  cost_increment_usd: number;
  cost_limit_usd: number;
  // True only while the run is held on the current limit's cost-exceeded event and still has an
  // interrupted step to resume. Web surfaces may call the explicit increase operation only then.
  cost_limit_increase_available: boolean;
  // Non-null while the run waits for an explicit human instruction (#1307). The run stays
  // `running` (active + resumable); the UI renders this as a Needs human state.
  needs_human_reason: string | null;
  issue_number: number;
  pr_number: number;
  created_at: string;
  updated_at: string;
  // Fixed lifecycle end. Unlike `updated_at`, terminal-run maintenance never advances it.
  ended_at: string | null;
  latest_step_runs?: {
    execute: WorkflowStepExecutionWire | null;
    verify: WorkflowStepExecutionWire | null;
  };
  latest_review: WorkflowRunReviewSummaryWire | null;
  verification_status: "unverified" | "verified" | "stale";
  // The linked PR's terminal state. Kept separate from `status === completed`, which also covers
  // closed-unmerged PRs.
  pr_merged: boolean;
  merge_ready: boolean;
  merge_conflict: boolean;
}

export interface WorkflowPendingEffectReceiptWire {
  event_id: number;
  effect: string;
  status: "pending";
  claimed_at: string;
}

export interface WorkflowOutOfBandReviewWire {
  id: number;
  verdict: "feedback" | "request_changes";
}

export interface WorkflowPendingStepLaunchWire {
  step: "execute" | "verify";
  session_id: string;
  head_sha: string | null;
}

// Complete observed state the Workflow parent's instructions are decided from. This wire shape
// remains in core even though its current presentation is CLI-only, so future web consumers share
// the same source of truth instead of re-declaring it.
export interface WorkflowStepStatusWire {
  run: number;
  current_step: string;
  display_stage?: "execute" | "verify" | "ready_to_merge" | "merged";
  status: string;
  active_step: string | null;
  rework_count: number;
  rework_limit: number;
  needs_human_reason: string | null;
  awaiting_human: boolean;
  pending_step_launch: WorkflowPendingStepLaunchWire | null;
  pending_effect_receipt: WorkflowPendingEffectReceiptWire | null;
  unaddressed_out_of_band_reviews: WorkflowOutOfBandReviewWire[];
  cost_increment_usd: number;
  cost_limit_usd: number;
  head_sha: string | null;
  head_ahead_of_base: boolean;
  head_ahead_of_latest_review: boolean;
  merge_conflict: boolean;
  // Canonical pre-merge merge-ready state derived from the current HEAD, its pinned review, and PR state.
  merge_ready: boolean;
  // The linked PR's own domain state. The run's terminal condition is read from these fields
  // rather than from a close / merge event, so every route lands on the same reconciliation.
  pr_merged: boolean;
  pr_closed: boolean;
  last_turn_done_at: string | null;
  turn_done_for_active_execute: boolean;
  // Whether a Verify child was launched after the latest turn done. False means the Verify marked
  // active was launched for older work, so waiting on it would never produce a review (#1857).
  verify_launched_after_turn_done: boolean;
  steps: WorkflowStepStatuses;
}

export function workflowRunStateJSON(input: {
  run: S.WorkflowRunRow;
  workflowName: string | null;
  latestReview: WorkflowRunReviewSummaryWire | null;
  verificationStatus: WorkflowRunStateWire["verification_status"];
  reworkLimit: number;
  reworkLimitIncreaseAvailable: boolean;
  costIncrementUsd: number;
  costLimitUsd: number;
  costLimitIncreaseAvailable: boolean;
  activeVerifyHeadSha: string | null;
  activeVerifyStartedAt: string | null;
  prMerged: boolean;
  mergeReady: boolean;
  mergeConflict: boolean;
  latestStepRuns: WorkflowRunStateWire["latest_step_runs"];
}): WorkflowRunStateWire {
  const { run } = input;
  return {
    id: run.id,
    workflow_id: run.workflow_id,
    workflow_name: input.workflowName,
    status: run.status,
    current_step: run.current_step,
    display_stage: input.prMerged
      ? "merged"
      : input.mergeReady
        ? "ready_to_merge"
        : (run.current_step as "execute" | "verify"),
    active_verify_head_sha: input.activeVerifyHeadSha,
    active_verify_started_at: input.activeVerifyStartedAt,
    rework_count: run.rework_count,
    rework_limit: input.reworkLimit,
    rework_limit_increase_available: input.reworkLimitIncreaseAvailable,
    cost_increment_usd: input.costIncrementUsd,
    cost_limit_usd: input.costLimitUsd,
    cost_limit_increase_available: input.costLimitIncreaseAvailable,
    needs_human_reason: run.needs_human_reason,
    issue_number: run.issue_number,
    pr_number: run.pr_number,
    created_at: run.created_at,
    updated_at: run.updated_at,
    ended_at: run.ended_at,
    latest_step_runs: input.latestStepRuns,
    latest_review: input.latestReview,
    verification_status: input.verificationStatus,
    pr_merged: input.prMerged,
    merge_ready: input.mergeReady,
    merge_conflict: input.mergeConflict,
  };
}

/** One domain subject an event names, normalized by core (see core/event-subjects.ts). */
export type EventSubjectWire =
  | { kind: "issue"; number: number }
  | { kind: "pull"; number: number }
  | { kind: "workflow_run"; id: number }
  | { kind: "scheduled_task"; id: number };

/** Wire format returned by events/list. */
export interface LoopEventWire {
  id: number;
  type: string;
  repo?: string;
  actor: string;
  /**
   * The stored payload as written by the producer: unversioned, type-specific, and on old rows
   * anything JSON can hold. Read domain subjects off `subjects`; narrow this only for metadata no
   * subject covers.
   */
  payload: unknown;
  subjects: EventSubjectWire[];
  created_at: string;
}

/**
 * How loudly one history event should read in a run's timeline (#1867, #1869). The classification
 * lives here, with the rest of the wire shape, so the dialog only owns three looks and never
 * reconstructs importance from label text.
 *
 * The history answers one question: is the normal flow (Execute → Verify → done) turning over as it
 * should? So each event is placed by whether it describes the *state of the work flow* (the "what" a
 * human watches) or the *agent-to-agent communication that drives the flow* (the "how" a human does
 * not care about) — and, for flow-state events, whether a phase/run is *starting* or *finishing*:
 *
 * - `notable` — the flow skeleton advancing or deviating. A phase/run finished and produced a result
 *   (Execute done, Verify passed or requested rework, run completed/merged), or the flow did not turn
 *   over normally (cost hold, needs-human, escalation, merge conflict). The direct answer to "is it
 *   turning over?".
 * - `default` — neither skeleton nor driving communication: a phase *starting*, or external input
 *   (GitHub feedback, a raised cost limit). Context markers that decide nothing on their own. Unknown
 *   and legacy event types land here too, so a type this function has never seen still renders.
 * - `routine` — communication that *drives* the flow and its internal rotation (turn done, step
 *   activation, handoff, resume, generic state updates, usage). The "how"; outside a human's concern.
 *
 * Supporting rule: when one real-world event emits several rows (e.g. Verify's change request shows up
 * as both `review_submitted REQUEST_CHANGES` and `updated: request_rework`), the row that carries the
 * substance keeps its natural significance and the duplicate ledger row drops to `routine`.
 *
 * Unknown/legacy types fall through to the `default` initial value, matching the principle: an
 * unclassified event is a context marker, not a skeleton or driving-communication signal.
 */
export type WorkflowRunHistorySignificance = "notable" | "default" | "routine";

/** One persisted lifecycle event shown in a Workflow run's history dialog. */
export interface WorkflowRunHistoryEventWire {
  id: number;
  type: string;
  label: string;
  description: string;
  significance: WorkflowRunHistorySignificance;
  input: string | null;
  step: string | null;
  actor: string;
  created_at: string;
}

export type WorkflowRunAgentRoleWire = "parent" | "execute" | "verify";

// Persisted Workflow participants grouped by role. The separate session counts keep a known
// subtotal from looking complete when usage is pending or a recorded model has no known price.
export interface WorkflowRunAgentCostWire {
  role: WorkflowRunAgentRoleWire;
  session_count: number;
  known_session_count: number;
  pending_session_count: number;
  unknown_session_count: number;
  cost_usd: number;
}

// Run-scoped total calculated from the same persisted participant set and cost summary used by
// Workflow budget enforcement. A partial total keeps the observed amount visible while one or more
// participant sessions have not reported usage yet.
export interface WorkflowRunTotalCostWire {
  cost_usd: number | null;
  cost_status: "known" | "partial" | "unknown" | "pending" | "not_recorded";
}

function workflowStepLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function workflowEventPayload(row: S.EventRow): StoredWorkflowEventPayload {
  return parseWorkflowEventPayload(row.payload) ?? {};
}

/**
 * Read one payload field, narrowed to the type the entry wants and null otherwise.
 *
 * Stored payloads keep every key optional (see core/workflow/event-payloads.ts): a row emitted
 * before a key existed simply lacks it, so every read needs the same fallback. These two accessors
 * are that narrowing, written once instead of per entry.
 */
function payloadString(
  payload: StoredWorkflowEventPayload,
  key: keyof StoredWorkflowEventPayload,
): string | null {
  const value: unknown = payload[key];
  return typeof value === "string" ? value : null;
}

function payloadNumber(
  payload: StoredWorkflowEventPayload,
  key: keyof StoredWorkflowEventPayload,
): number | null {
  const value: unknown = payload[key];
  return typeof value === "number" ? value : null;
}

/** What an entry below may read to phrase a row. */
interface WorkflowRunHistoryEventContext {
  type: string;
  payload: StoredWorkflowEventPayload;
  /** The step the payload names, raw and in display form; null when it names none. */
  step: string | null;
  stepLabel: string | null;
  /** The verdict the caller resolved from the review a `review_submitted` row points at. */
  reviewVerdict: string | null;
}

/** A constant, or a function of the row's context when the value depends on the payload. */
type WorkflowRunHistoryField<T> =
  | T
  | ((context: WorkflowRunHistoryEventContext) => T);

/**
 * How one event type reads in the history dialog. All three fields are required so a new entry
 * cannot silently inherit a significance it never considered.
 */
interface WorkflowRunHistoryEventEntry {
  label: WorkflowRunHistoryField<string>;
  description: WorkflowRunHistoryField<string>;
  significance: WorkflowRunHistoryField<WorkflowRunHistorySignificance>;
}

function workflowRunHistoryField<T>(
  field: WorkflowRunHistoryField<T>,
  context: WorkflowRunHistoryEventContext,
): T {
  return typeof field === "function"
    ? (field as (context: WorkflowRunHistoryEventContext) => T)(context)
    : field;
}

/**
 * The facts a `workflow_run.updated` row's label, description and significance all read. Derived
 * once so the three entry fields below cannot drift apart in how they interpret the same payload.
 */
interface WorkflowRunUpdatedFacts {
  status: string;
  transition: string | null;
  /**
   * `needs_human_reason` is present in the payload only when the update touched the human wait
   * (#1307): a string marks the escalation, an explicit null marks the human-instructed resume.
   */
  touchedNeedsHuman: boolean;
  needsHumanReason: string | null;
}

function workflowRunUpdatedFacts({
  payload,
}: WorkflowRunHistoryEventContext): WorkflowRunUpdatedFacts {
  return {
    status: payloadString(payload, "status") ?? "updated",
    transition: payloadString(payload, "transition"),
    touchedNeedsHuman: "needs_human_reason" in payload,
    needsHumanReason: payloadString(payload, "needs_human_reason"),
  };
}

/**
 * Event type → how the history dialog reads it. One entry per type: adding an event type means
 * adding an entry here, not threading a branch through a chain.
 */
const WORKFLOW_RUN_HISTORY_EVENTS: Record<
  string,
  WorkflowRunHistoryEventEntry
> = {
  "workflow_run.started": {
    label: "Run started",
    description: ({ payload }) =>
      payload.id === undefined
        ? "Workflow run started."
        : `Workflow run ${String(payload.id)} started.`,
    significance: "default",
  },
  "workflow_run.updated": {
    // `completed` marks the run's terminal condition: its linked PR closed. A passing
    // Verify does not reach it — that keeps the run `running` + `verification_status: verified`
    // (#1513). `stopped` (#1525) stays a legacy status with no write path (a cost stop interrupts
    // only the child); old event rows can still carry it, like the legacy `blocked` case.
    label: (context) => {
      const { status, transition, touchedNeedsHuman, needsHumanReason } =
        workflowRunUpdatedFacts(context);
      return status === "completed"
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
                ? // The parent only reaches this transition after `advanceToVerify` has confirmed
                  // Execute complete (HEAD moved, turn declared), so it is the run's record of
                  // "Execute finished implementing" — named for that rather than for the
                  // bookkeeping move it performs (#1867).
                  "Execute completed"
                : transition === "request_rework"
                  ? "Run rework requested"
                  : transition === "activate_step"
                    ? "Step agent activated"
                    : "Run state updated";
    },
    description: (context) => {
      const { status, transition, touchedNeedsHuman, needsHumanReason } =
        workflowRunUpdatedFacts(context);
      const reworkCount = payloadNumber(context.payload, "rework_count");
      return [
        transition === "advance_to_verify"
          ? "Execute finished implementing; the run moved on to Verify."
          : null,
        `Status: ${workflowStepLabel(status) ?? status}.`,
        touchedNeedsHuman
          ? needsHumanReason !== null
            ? `Waiting for a human: ${needsHumanReason}`
            : "Human wait cleared; the run may progress again."
          : null,
        context.stepLabel ? `Current step: ${context.stepLabel}.` : null,
        reworkCount !== null ? `Rework count: ${reworkCount}.` : null,
      ]
        .filter((value): value is string => value !== null)
        .join(" ");
    },
    // Placed by the principle above. A run that left `running` finished or deviated — a flow-state
    // result, so notable. An escalation into a human wait is a deviation (notable); `advance_to_verify`
    // and `request_rework` are the flow skeleton reaching a decision, i.e. Execute finishing and Verify
    // sending the run back (notable). Everything else this event carries — the activation paired with
    // every step launch, the resume that follows a human's instruction, an unrecognized transition — is
    // driving communication, the parent narrating its own bookkeeping (routine).
    significance: (context) => {
      const { status, transition, touchedNeedsHuman, needsHumanReason } =
        workflowRunUpdatedFacts(context);
      return status !== "running"
        ? "notable"
        : touchedNeedsHuman
          ? needsHumanReason !== null
            ? "notable"
            : "routine"
          : transition === "advance_to_verify" ||
              transition === "request_rework"
            ? "notable"
            : "routine";
    },
  },
  "workflow_step.launched": {
    label: ({ stepLabel }) => `${stepLabel ?? "Workflow"} step started`,
    description: ({ stepLabel }) =>
      `${stepLabel ?? "Workflow"} step execution started.`,
    significance: "default",
  },
  "workflow_step.launch_failed": {
    label: ({ stepLabel }) => `${stepLabel ?? "Workflow"} step launch failed`,
    description: ({ stepLabel, payload }) =>
      `${stepLabel ?? "Workflow"} step failed before spawn: ${payloadString(payload, "reason") ?? "No reason recorded."}`,
    significance: "notable",
  },
  "workflow_run.turn_done": {
    label: "Turn done declared",
    description:
      "Execute declared its turn done. The parent observes HEAD and review state before any transition.",
    significance: "routine",
  },
  "workflow_run.escalated": {
    label: "Human guidance requested",
    description: ({ payload }) =>
      `Execute requested human guidance: ${payloadString(payload, "reason") ?? "No reason recorded."}`,
    significance: "notable",
  },
  "workflow_run.cost_exceeded": {
    label: "Cost limit exceeded",
    description: ({ payload }) => {
      const cost = payloadNumber(payload, "cost_usd");
      const limit = payloadNumber(payload, "limit_usd");
      return cost !== null && limit !== null
        ? `Run cost $${cost.toFixed(2)} passed the $${limit.toFixed(2)} limit. The run holds until the limit is raised.`
        : "Run cost passed its limit. The run holds until the limit is raised.";
    },
    significance: "notable",
  },
  "workflow_run.cost_limit_increased": {
    label: "Cost limit raised",
    description: ({ payload }) => {
      const previous = payloadNumber(payload, "previous_limit_usd");
      const current = payloadNumber(payload, "current_limit_usd");
      return previous !== null && current !== null
        ? `A human raised the run's cost limit from $${previous.toFixed(2)} to $${current.toFixed(2)}.`
        : "A human raised the run's cost limit so it may continue.";
    },
    significance: "default",
  },
  "workflow_run.merge_conflict": {
    label: "Merge conflict detected",
    description:
      "The linked PR conflicts with its base. The run cannot progress until the conflict is resolved.",
    // The done stage failing to turn over is a flow deviation, not driving communication (#1869):
    // it is the direct answer to "is the flow proceeding?" — no. #1868 read it as routine on the
    // assumption the run resolves it unattended, but by the principle a stall of the skeleton is
    // notable regardless of who clears it.
    significance: "notable",
  },
  // A passing review is Verify finishing with nothing left to fix — a flow-skeleton completion, so
  // notable. A change-requesting one is the duplicate ledger row for the same real event: the
  // substance rides the `updated: request_rework` transition (notable), so by the supporting rule
  // this row drops to routine. An unresolved verdict is likewise just the parent's wake ping.
  //
  // The run reads its submissions off `pull_request.review_submitted` now; the `workflow_run.`
  // entry below stays for the twins already stored. Both read the same way, because both carry
  // only `review_id` and the review row remains the verdict.
  "pull_request.review_submitted": {
    label: ({ reviewVerdict }) =>
      reviewVerdict === "PASS"
        ? "Review passed"
        : reviewVerdict === "REQUEST_CHANGES"
          ? "Review requested changes"
          : "Review submitted",
    description: ({ payload, reviewVerdict }) => {
      const reviewId = payloadNumber(payload, "review_id");
      const subject = reviewId !== null ? `Review #${reviewId}` : "A review";
      return reviewVerdict === "PASS"
        ? `${subject} passed on the linked PR — Verify cleared this implementation.`
        : reviewVerdict === "REQUEST_CHANGES"
          ? `${subject} requested changes on the linked PR. The run reworks unless a human steps in.`
          : `${subject} was submitted on the linked PR. Its verdict decides whether the run advances or reworks.`;
    },
    significance: ({ reviewVerdict }) =>
      reviewVerdict === "PASS" ? "notable" : "routine",
  },
  "workflow_run.review_submitted": {
    label: ({ reviewVerdict }) =>
      reviewVerdict === "PASS"
        ? "Review passed"
        : reviewVerdict === "REQUEST_CHANGES"
          ? "Review requested changes"
          : "Review submitted",
    description: ({ payload, reviewVerdict }) => {
      const reviewId = payloadNumber(payload, "review_id");
      const subject = reviewId !== null ? `Review ${reviewId}` : "A review";
      return reviewVerdict === "PASS"
        ? `${subject} passed on the linked PR — Verify cleared this implementation.`
        : reviewVerdict === "REQUEST_CHANGES"
          ? `${subject} requested changes on the linked PR. The run reworks unless a human steps in.`
          : `${subject} was submitted on the linked PR. Its verdict decides whether the run advances or reworks.`;
    },
    significance: ({ reviewVerdict }) =>
      reviewVerdict === "PASS" ? "notable" : "routine",
  },
  // A human pointing at a line of the diff is new input the run did not plan for — a deviation from
  // the flow rather than the parent narrating its own bookkeeping, so notable by the principle above.
  "workflow_run.diff_feedback": {
    label: "Diff comment received",
    description: ({ payload }) => {
      const threadId = payloadNumber(payload, "thread_id");
      return threadId !== null
        ? `A comment landed on diff conversation ${threadId}. The parent hands it to Execute.`
        : "A comment landed on the PR diff. The parent hands it to Execute.";
    },
    significance: "notable",
  },
  "workflow_run.pr_comment": {
    label: "PR comment received",
    description: ({ payload }) => {
      const commentId = payloadNumber(payload, "comment_id");
      return commentId !== null
        ? `PR comment ${commentId} was sent to Execute.`
        : "A PR comment was sent to Execute.";
    },
    significance: "notable",
  },
  "workflow_run.github_event": {
    label: "GitHub feedback received",
    description: ({ payload }) => {
      const githubNumber = payloadNumber(payload, "github_number");
      return githubNumber !== null
        ? `New review feedback landed on GitHub PR #${githubNumber}.`
        : "New review feedback landed on the linked GitHub pull request.";
    },
    significance: "default",
  },
  // Legacy history entry: merge now emits workflow_run.closed, but existing databases retain
  // workflow_run.merged rows that must keep their original presentation.
  "workflow_run.merged": {
    label: "Linked PR merged",
    description: ({ payload }) => {
      const prNumber = payloadNumber(payload, "pr_number");
      return prNumber !== null
        ? `PR #${prNumber} merged — the run's terminal condition.`
        : "The linked PR merged — the run's terminal condition.";
    },
    significance: "notable",
  },
  "workflow_run.closed": {
    label: "Linked PR closed",
    description: ({ payload }) => {
      const prNumber = payloadNumber(payload, "pr_number");
      return prNumber !== null
        ? `PR #${prNumber} closed — the run's terminal condition.`
        : "The linked PR closed — the run's terminal condition.";
    },
    significance: "notable",
  },
  "workflow_run.usage_updated": {
    label: "Usage updated",
    description: "Agent usage totals for this run were refreshed.",
    significance: "routine",
  },
};

/**
 * How an unrecognized type reads: the event name spelled out, no claim about what happened, and the
 * `default` significance the principle above assigns an unclassified event.
 */
const WORKFLOW_RUN_HISTORY_FALLBACK: WorkflowRunHistoryEventEntry = {
  label: ({ type }) =>
    type
      .replace(/^workflow_/u, "")
      .replace(/[._-]+/gu, " ")
      .replace(/^./u, (value) => value.toUpperCase()),
  description: "Workflow lifecycle event recorded.",
  significance: "default",
};

/**
 * Normalize stored event payloads into stable, reader-facing timeline entries.
 *
 * `reviewVerdict` is the `event` column of the review a `workflow_run.review_submitted` row points
 * at ("PASS" / "REQUEST_CHANGES" / …). The event payload only carries `review_id` — the review row
 * stays the sole verdict source — so the caller resolves it, the same way it resolves `input` from
 * the handoff. Null when unresolvable, which reads as an unknown verdict.
 */
export function workflowRunHistoryEventJSON(
  row: S.EventRow,
  input: string | null = null,
  reviewVerdict: string | null = null,
): WorkflowRunHistoryEventWire {
  const payload = workflowEventPayload(row);
  const step =
    payloadString(payload, "step") ?? payloadString(payload, "current_step");
  const context: WorkflowRunHistoryEventContext = {
    type: row.type,
    payload,
    step,
    stepLabel: workflowStepLabel(step),
    reviewVerdict,
  };
  const entry =
    WORKFLOW_RUN_HISTORY_EVENTS[row.type] ?? WORKFLOW_RUN_HISTORY_FALLBACK;

  return {
    id: row.id,
    type: row.type,
    label: workflowRunHistoryField(entry.label, context),
    description: workflowRunHistoryField(entry.description, context),
    significance: workflowRunHistoryField(entry.significance, context),
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
//   - "in_progress": session start → now — no ready_for_review event yet, so the clock is still
//     running.
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
  // was merged/closed without ever passing through a ready_for_review transition — see below). Null only
  // when there is no dev session to anchor from (mirrors `total.basis === null`).
  implementation: PullWorkPhase | null;
  // The first ready_for_review event → merged_at/closed_at, or → now while still under review. Null
  // until the PR has reached ready_for_review at least once — there is nothing to report yet.
  review: PullWorkPhase | null;
}

// How long the PR's dev session took (#456), split into three figures anchored at the primary dev
// session's start (agent_sessions.created_at — set once at `sessions.register` and never
// touched again by resumes, so it is a stable start marker):
//   - total: start → the clearest completion signal (see PullWorkDurationBasis), or now.
//   - implementation: start → the first ready_for_review event — the phase before a
//     reviewer/human ever saw the PR. A PR that merges/closes without ever passing through
//     ready_for_review has no event to anchor
//     to; implementation then covers the PR's whole life and `review` stays null, since there is no
//     signal marking a review phase ever began.
//   - review: the first ready_for_review event → merged_at/closed_at/now — review + any fix-cycle
//     time after the implementation handoff.
// Returns `{ total: { seconds: null, basis: null }, implementation: null, review: null }` — the
// fallback the frontend renders as "N/A" — when there is no dev session to anchor the calculation.
export function pullWorkDuration(
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
  archived_at: string | null;
  labels: LabelWire[];
  comments: number;
  // Full PR comments are included on detail responses so an Execute child can read a human comment
  // named by a workflow notification with `lh pr view --json`.
  comment_list?: CommentWire[];
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
  // #2383: when this PR's in-flight GitHub export began, or null when none is in flight. Both this
  // and `github_pull` project the same export record, so exactly one of them can be set: a record
  // still 'creating' has no GitHub PR to report, and one that reached 'linked' is no longer
  // starting. The detail's Create action renders it as in-progress for as long as it counts as
  // running.
  github_pr_export_started_at: string | null;
  // Detail-only: commits on head not reachable from base (base..head), newest first. Omitted from
  // list responses so their bounded pagination does not add one git log per row.
  commits?: PullCommitWire[];
  // Detail-only (#298, #456): the PR's related sessions, aggregate usage, and derived work
  // duration. Gated so the PR list/dashboard stay O(1) git + no extra per-row query.
  related_sessions?: RelatedSessionWire[];
  related_sessions_usage?: RelatedSessionsUsageWire;
  work_duration?: PullWorkDuration;
}

/** Data selected together for the repository issue-list screen. */
export interface IssueListPageWire {
  issues: IssueWire[];
  repo: RepoWire;
  workspaces: WorkspaceWire[];
  labels: LabelWire[];
  /**
   * Display state of the Workflow run linked to each PR the rows above show, for the mini tracker
   * on the row (#112). Selected with the page rather than per row so one event does not fan out
   * into one request per row; each entry names its PR in `pr_number`, and a PR with no run is
   * simply absent. Same shape the per-PR `workflowRuns/stateForPull` returns, so the client seeds
   * that query's cache with these and the row reads them from there.
   */
  workflow_runs: WorkflowRunStateWire[];
}

/** Data selected together for the issue-detail screen. */
export interface IssueDetailPageWire {
  issue: IssueWire;
  comments: CommentWire[];
  acceptance_criteria: AcceptanceCriterionDetailWire[];
  workflow_runs: WorkflowRunStateWire[];
}

export interface SubIssuesPageWire {
  issues: IssueWire[];
  truncated: boolean;
  workflow_runs: WorkflowRunStateWire[];
}

/** A changed file with its unified-diff patch. */
export interface PullFileWire {
  filename: string;
  previousFilename?: string;
  headFilename?: string;
  /** Committer date of the newest PR commit that changed this file. */
  last_changed_at?: string;
  /**
   * Sha of that same commit — the version of the file a reader is looking at, which a "viewed"
   * record pins so later commits to the file can be told apart from it (#2502).
   */
  last_changed_sha?: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

/**
 * A changed file the supervisor has marked viewed, and the version they marked (#2502). One entry
 * per path: the newest record, which is what the screens read. Paths whose newest record unmarks
 * the file are absent.
 */
export interface PullFileViewWire {
  path: string;
  /** The file's newest PR commit when it was marked, or null when the walk named none. */
  sha: string | null;
  viewed_at: string;
}

/** Data selected together for the pull-request detail screen. */
export interface PullDetailPageWire {
  pull: PullWire;
  files: PullFileWire[];
  reviews: ReviewWire[];
  line_comments: ReviewCommentWire[];
  comments: CommentWire[];
  /**
   * The whole PR activity in one chronological list (#145): commits, reviews and conversation
   * comments, oldest first. Assembled by pageData.pullDetail from the fields above —
   * `pull.commits`, `reviews` and `comments` — so it costs the page no extra git,
   * query or HTTP work, and the frontend renders the array as-is.
   */
  timeline: PullTimelineItemWire[];
  /**
   * The diff feedback the detail screen itself renders: the per-file badge counts under Files
   * changed, and the threads whose anchors have left the diff ("previous threads"). Both are
   * derived from `files`, so folding them in here costs no extra git and spares the screen two
   * `diffFeedback/list` calls on load (#123). Threads anchored in the current diff stay out — the
   * diff dialog fetches those per path when a file is opened.
   */
  diff_feedback: {
    comment_counts: Record<string, number>;
    orphaned_threads: DiffFeedbackThreadWire[];
  };
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

/**
 * Something that happened on the linked GitHub PR, as the PR timeline shows it (#2500). Read from
 * what the worker's GitHub syncs already observed — no GitHub request is made to build it — so a
 * field GitHub did not give us (or an item observed before those fields were recorded) is null and
 * the entry degrades to its type and its link rather than disappearing.
 */
export interface PullGithubActivityWire {
  /** What happened: a conversation comment, a submitted review, an inline diff comment, or a merge. */
  type: "issue_comment" | "review" | "review_comment" | "merged";
  /** The linked GitHub PR's number, so an entry says which PR it happened on. */
  github_number: number;
  /**
   * GitHub's own id for the comment or review, which is the entry's identity even when two items
   * share a timestamp or fall back to the same URL. Null for the merge entry — a merge is the PR
   * changing state, not an item of its own.
   */
  github_id: number | null;
  /**
   * Where to read it on GitHub: the item's own anchor, or the PR itself for a merge and for an item
   * observed before permalinks were recorded.
   */
  url: string;
  /** GitHub login of the comment's or review's author, when it was recorded. */
  author: string | null;
  /** The submitted review's verdict; null for every other type. */
  review_state: GithubReviewState | null;
}

/**
 * One entry in the PR-detail timeline (#145): a commit, a review, a conversation comment, or
 * something that happened on the linked GitHub PR (#2500), in display order (chronological, oldest
 * first). Assembled by pageData.pullDetail from data the page already fetches (`pull.commits` /
 * `reviews` / `comments`) plus the GitHub activity the worker has already observed, so the frontend
 * renders the array as-is and never rebuilds or re-sorts it. `created_at` is the entry's timestamp
 * on its own, uniform across kinds. Review line comments remain available through `line_comments`
 * for the Diff view.
 */
export type PullTimelineItemWire =
  | {
      kind: "commit";
      created_at: string;
      commit: PullCommitWire;
    }
  | {
      kind: "review";
      created_at: string;
      review: ReviewWire;
    }
  | {
      kind: "comment";
      created_at: string;
      comment: CommentWire;
    }
  | {
      kind: "github_activity";
      created_at: string;
      github_activity: PullGithubActivityWire;
    };

// The stored review verdict is plain text (the column is written from a GitHub response), so the
// wire narrows it back to the union rather than trusting the row.
const GITHUB_REVIEW_STATES: readonly GithubReviewState[] = [
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
];

/** A stored review verdict as the wire's own union, or null when it is absent or unrecognized. */
function githubReviewState(value: string | null): GithubReviewState | null {
  return GITHUB_REVIEW_STATES.find((state) => state === value) ?? null;
}

/**
 * The GitHub-side timeline entries for one PR: every feedback item the worker observed, plus the
 * merge it detected. Pure — the rows are read by the caller, and the entries are ordered by the
 * caller's own chronological sort along with the LoopHub ones.
 */
export function pullGithubTimelineJSON(
  link: S.GithubPull,
  observations: S.GithubFeedbackObservation[],
): Extract<PullTimelineItemWire, { kind: "github_activity" }>[] {
  const entries: Extract<PullTimelineItemWire, { kind: "github_activity" }>[] =
    observations.map((observation) => ({
      kind: "github_activity",
      created_at: observation.created_at ?? observation.updated_at,
      github_activity: {
        type: observation.kind,
        github_number: link.number,
        github_id: observation.github_id,
        // A row observed before the permalink was recorded still leads somewhere useful: the PR.
        url: observation.url ?? link.url,
        author: observation.author_login,
        review_state:
          observation.kind === "review"
            ? githubReviewState(observation.review_state)
            : null,
      },
    }));
  if (link.github_merged && link.github_merged_at) {
    entries.push({
      kind: "github_activity",
      created_at: link.github_merged_at,
      github_activity: {
        type: "merged",
        github_number: link.number,
        github_id: null,
        url: link.url,
        author: null,
        review_state: null,
      },
    });
  }
  return entries;
}
