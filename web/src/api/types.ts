// Types mirroring the LoopHub REST API (see ../../../API.md). Wire shapes produced by
// core/serialize.ts are type-only imports from core (single source of truth, #746) — a
// serializer change that alters a shape breaks this build instead of silently drifting.
// HerdrPullWorkspace/HerdrIssueWorkspace likewise derive from core/terminal/herdr-status.ts,
// whose interfaces the terminal/sessions RPC returns as-is. The remaining shapes with no core
// counterpart (Terminal/Stats/dashboard) stay hand-written below.
import type { FileAtRef as FileAtRefWire } from "../../../core/git.ts";
import type { MergeMode } from "../../../core/merge-mode.ts";
import type {
  AcceptanceCriterionDetailWire,
  AcceptanceCriterionWire,
  AgentCostSummaryWire,
  AgentSessionWire,
  CodingAgent as CodingAgentWire,
  CommentWire,
  DiffFeedbackListWire,
  DiffFeedbackMessageWire,
  DiffFeedbackThreadWire,
  EventSubjectWire,
  GithubPrStatusWire,
  GithubPullWire,
  GlobalSettingsWire,
  HandoffWire,
  HerdrRepoSessionsWire,
  HerdrSessionAgentWire,
  HerdrSessionsWire,
  IssueDetailPageWire,
  IssueListPageWire,
  IssueListPullSummaryWire,
  IssueWire,
  LabelWire,
  LinkedIssueWire,
  LoopEventWire,
  NotificationWire,
  PullDetailPageWire,
  PullDiffWire,
  PullFileWire,
  PullSummaryWire,
  PullUsageWire,
  PullWire,
  RelatedSessionsUsageByKindWire,
  RelatedSessionsUsageWire,
  RelatedSessionWire,
  RepoAgentConfigWire,
  RepoMergeModeWire,
  RepoWire,
  ReviewAcResultWire,
  ReviewCommentWire,
  ReviewWire,
  SearchResultWire,
  SessionLinkedTargetWire,
  SessionSubagentUsageWire,
  SessionUsageWire,
  TerminalLaunchBackendWire,
  TerminalLaunchResultWire,
  ThemeWire,
  UserWire,
  WebConfigWire,
  WorkerCompatibilityWire,
  WorkflowContractLanguageWire,
  WorkflowContractsWire,
  WorkflowRunHistoryEventWire,
  WorkflowRunReviewSummaryWire,
  WorkflowRunStateWire,
  WorkflowStepStatusWire,
  WorkflowWire,
  WorkspaceResolutionWire,
  WorkspaceWire,
} from "../../../core/serialize.ts";
import type {
  HerdrIssueWorkspace as HerdrIssueWorkspaceWire,
  HerdrPullWorkspace as HerdrPullWorkspaceWire,
} from "../../../core/terminal/herdr-status.ts";

export type WebConfig = WebConfigWire;

export type Label = LabelWire;

export type UserRef = UserWire;

export type SearchResult = SearchResultWire;

/**
 * Summary of the pull request linked to an issue. The base fields (including the #783 agent-cost
 * totals) are always present (issue-detail `linked_pull_request`); the rest are populated only on
 * the issue-list response (issueListItemJSON), which runs the git status fan-out per row.
 */
export type LinkedPull = PullSummaryWire &
  Partial<
    Pick<
      IssueListPullSummaryWire,
      | "working"
      | "review_state"
      | "mergeable_state"
      | "additions"
      | "deletions"
      | "changed_files"
      | "commits_ahead"
      | "base_commits_behind"
      | "agent_runtime"
      | "agent_model"
      | "work_duration_total"
      | "workflow_rework_count"
      | "total_comments"
    >
  >;

/** Summary of the issue a PR closes (pull-detail `linked_issue`). */
export type LinkedIssue = LinkedIssueWire;

/** A comment on an issue (GET .../issues/{number}/comments). */
export type IssueComment = CommentWire;

/** A submitted review on a PR (GET .../pulls/{number}/reviews). */
export type PullReview = ReviewWire;

export type WorkflowStepStatus = WorkflowStepStatusWire;

/** A line comment on a PR (GET .../pulls/{number}/comments). */
export type PullLineComment = ReviewCommentWire;

/** A changed file with its unified-diff patch (GET .../pulls/{number}/files). */
export type PullFile = PullFileWire;
export type PullDiff = PullDiffWire;
export type DiffFeedbackList = DiffFeedbackListWire;
export type DiffFeedbackThread = DiffFeedbackThreadWire;
export type DiffFeedbackMessage = DiffFeedbackMessageWire;

/**
 * Whole-file content of a changed file at one side (base/head) of a PR (#435), for the Markdown
 * preview modal. "missing" covers an added file (absent from base) or a deleted file (absent
 * from head); "binary" flags content that isn't renderable as text.
 */
export type FileAtRef = FileAtRefWire;

// An orchestrator<->subagent handoff (#352), as shown in the PR detail's Handoffs section. `body`
// is inline content (instruction / Verify report) when present; otherwise `src` references a
// canonical copy (plan=PR, diff=commit) and `hash` is its content hash.
export type Handoff = HandoffWire;

export type Notification = NotificationWire;

export type Repo = RepoWire;

export type Workspace = WorkspaceWire;
export type WorkspaceResolution = WorkspaceResolutionWire;

export type { MergeMode };

/** Resolved merge-mode view for the repo settings UI (`repos/mergeMode`, #406). */
export type RepoMergeMode = RepoMergeModeWire;

/** Resolved Coding agent override view for the repo settings UI (`repos/agentConfig`, #1532). */
export type RepoAgentConfig = RepoAgentConfigWire;

export type TerminalLaunchBackend = TerminalLaunchBackendWire;

export type TerminalLaunchResult = TerminalLaunchResultWire;

/** One agent inside a running herdr session (`terminal/sessions`, #495). */
export type HerdrAgent = HerdrSessionAgentWire;

/**
 * A running herdr agent's pane, keyed back to the PR whose worktree it's running in
 * (`terminal/sessions`, #579 — the issue-list Herdr badge). `pane_id` is a valid
 * `terminal/focusAgent` target.
 */
export type HerdrPullWorkspace = HerdrPullWorkspaceWire;

/**
 * A running herdr agent's pane resolved to the *issue* its PR closes (`terminal/sessions`, #821 —
 * the issue-detail Agents section). Issue-keyed counterpart of HerdrPullWorkspace; `pane_id` is a
 * valid `terminal/focusAgent` target.
 */
export type HerdrIssueWorkspace = HerdrIssueWorkspaceWire;

/** A repo's running herdr session and its agents (`terminal/sessions`, #495). */
export type HerdrRepoSessions = HerdrRepoSessionsWire;

export type HerdrSessions = HerdrSessionsWire;

/**
 * Recent terminal output for one herdr agent (`terminal/agentRead`, #500), for the
 * terminal preview. `output` is null when herdr isn't running, the session is
 * gone, or the agent is no longer present — never an error.
 */
export interface HerdrAgentRead {
  output: string | null;
  /**
   * Target pane's size in character cells (columns/rows), for sizing the hover preview
   * to the pane's actual shape instead of a fixed box (#531). Null when herdr couldn't
   * report it — e.g. the read target is the display-name fallback (no real pane_id), or
   * herdr failed — and the client falls back to a fixed size.
   */
  cols: number | null;
  rows: number | null;
}

/**
 * Default coding agent when no --claude-code / --codex / --grok flag is passed (#516). Derived
 * from core (core/runtimes.ts via core/serialize.ts) so the runtime set is defined once — the
 * wire-types SSOT rule (AGENTS.md), same as every other core-derived type here.
 */
export type CodingAgent = CodingAgentWire;

/** Instance-level settings (`settings/get`, `settings/update`, #474). */
export type GlobalSettings = GlobalSettingsWire;

export type Theme = ThemeWire;
export type WorkflowContractLanguage = WorkflowContractLanguageWire;

/** Database statistics (`stats/get`, #587) for the /stats page. */
export interface Stats {
  database: {
    path: string;
    size_bytes: number;
    /** Size of the `-wal` companion file, or null when none exists. */
    wal_size_bytes: number | null;
    /** size_bytes + wal_size_bytes — the DB's real on-disk footprint under WAL. */
    total_size_bytes: number;
  };
  /** Row counts for every user table, name-ordered. */
  tables: { name: string; rows: number }[];
  /** Per-repo issue/PR tallies. A merged PR counts as merged only, not closed. */
  repos: {
    full_name: string;
    issues: { open: number; closed: number };
    pulls: { open: number; merged: number; closed: number };
  }[];
}

export type SessionUsage = SessionUsageWire;

export type SessionSubagentUsage = SessionSubagentUsageWire;

export type SessionLinkedTarget = SessionLinkedTargetWire;

/** Agent session list row (`sessions/list`). Usage and links are present when known. */
export type AgentSession = AgentSessionWire;

export type AgentCostSummary = AgentCostSummaryWire;

/** The GitHub PR a loophub PR was exported to (#406), or null until the export skill records one. */
export type GithubPull = GithubPullWire;

/** GitHub-side status of a PR's linked GitHub PR (#850), fetched on demand via `pulls/githubStatus`. */
export type GithubPrStatus = GithubPrStatusWire;

export type Issue = IssueWire;

/** A structured acceptance criterion (#1894) carried on issue detail; the Verify rubric source. */
export type AcceptanceCriterion = AcceptanceCriterionWire;

/** An acceptance criterion in the authoring surface, including disabled criteria. */
export type AcceptanceCriterionDetail = AcceptanceCriterionDetailWire;

/** A global workflow definition (#997): Execute/Verify prompt bundle. */
export type Workflow = WorkflowWire;
export type WorkflowContracts = WorkflowContractsWire;
export type WorkerCompatibility = WorkerCompatibilityWire;

/** Display state of a Workflow run linked to an issue / PR (#1008). */
export type WorkflowRunState = WorkflowRunStateWire;
export type WorkflowRunHistoryEvent = WorkflowRunHistoryEventWire;
export type WorkflowRunReviewSummary = WorkflowRunReviewSummaryWire;
/** One per-criterion rubric grade attached to a review (#1895). */
export type ReviewAcResult = ReviewAcResultWire;

export type PullRequest = PullWire;
export type IssueListPage = IssueListPageWire;
export type IssueDetailPage = IssueDetailPageWire;
export type PullDetailPage = PullDetailPageWire;

/** A PR's agent-cost totals on their own, served without touching git (#2263). */
export type PullUsage = PullUsageWire;

/** A session related to a PR or issue (#298), including its persisted runtime identity. */
export type RelatedSession = RelatedSessionWire;

export type RelatedSessionsUsage = RelatedSessionsUsageWire;

export type RelatedSessionsUsageByKind = RelatedSessionsUsageByKindWire;

/** Minimal repo identity attached to aggregated dashboard items. */
export interface RepoRef {
  full_name: string;
  owner: string;
  name: string;
}

/** One recently created open issue plus its repo (dashboard/overview). */
export interface DashboardIssueItem {
  repo: RepoRef;
  issue: Issue;
}

/** Cross-repo top-page overview (dashboard/overview). */
export interface DashboardOverview {
  issues: DashboardIssueItem[];
  /** Max issues the overview returns; used to note when the list is capped. */
  recentIssuesLimit: number;
}

/** One domain subject an event names, normalized by core (core/event-subjects.ts). */
export type EventSubject = EventSubjectWire;

/** Wire format returned by events/list. */
export type LoopEvent = LoopEventWire;
