// Types mirroring the LoopHub REST API (see ../../../API.md). Wire shapes produced by
// core/serialize.ts are type-only imports from core (single source of truth, #746) — a
// serializer change that alters a shape breaks this build instead of silently drifting.
// Shapes with no core serializer (Herdr/Terminal/Settings/Stats/dashboard/events) stay
// hand-written below.
import type { MergeMode } from "../../../core/merge-mode.ts";
import type {
  AgentSessionWire,
  CommentWire,
  GithubPullWire,
  HandoffWire,
  IssueGroupWire,
  IssueListPullSummaryWire,
  IssueWire,
  LabelWire,
  LinkedIssueWire,
  PullSummaryWire,
  PullWire,
  RelatedSessionsUsageByKindWire,
  RelatedSessionsUsageWire,
  RelatedSessionWire,
  RepoWire,
  ReviewCommentWire,
  ReviewNoteWire,
  ReviewWire,
  SessionLinkedTargetWire,
  SessionSubagentUsageWire,
  SessionUsageWire,
  UserWire,
} from "../../../core/serialize.ts";

export type Label = LabelWire;

export type UserRef = UserWire;

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
    >
  >;

/** Summary of the issue a PR closes (pull-detail `linked_issue`). */
export type LinkedIssue = LinkedIssueWire;

/** A comment on an issue (GET .../issues/{number}/comments). */
export type IssueComment = CommentWire;

/** A submitted review on a PR (GET .../pulls/{number}/reviews). */
export type PullReview = ReviewWire;

/** A line comment on a PR (GET .../pulls/{number}/comments). */
export type PullLineComment = ReviewCommentWire;

/** A changed file with its unified-diff patch (GET .../pulls/{number}/files). */
export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Whole-file content of a changed file at one side (base/head) of a PR (#435), for the Markdown
 * preview modal. "missing" covers an added file (absent from base) or a deleted file (absent
 * from head); "binary" flags content that isn't renderable as text.
 */
export interface FileAtRef {
  status: "ok" | "missing" | "binary";
  content?: string;
}

/**
 * A per-file diff description note (review_notes; #204, PR-independent since #216).
 * Identity is the commit range (base_sha→commit_sha) + path; pull_request is an optional
 * association to the owning PR (null for a PR-independent note). A consumer compares
 * commit_sha against the PR's live head to decide staleness.
 */
export type ReviewNote = ReviewNoteWire;

// An orchestrator<->subagent handoff (#352), as shown in the PR detail's Handoffs section. `body`
// is inline content (instruction / Verify report) when present; otherwise `src` references a
// canonical copy (plan=PR, diff=commit) and `hash` is its content hash.
export type Handoff = HandoffWire;

export type Repo = RepoWire;

export type { MergeMode };

/** Resolved merge-mode view for the repo settings UI (`repos/mergeMode`, #406). */
export interface RepoMergeMode {
  setting: MergeMode | null;
  has_github_remote: boolean;
  effective: MergeMode;
}

export type TerminalLaunchBackend = "builtin" | "herdr";

export interface TerminalLaunchResult {
  backend: TerminalLaunchBackend;
  session_name?: string;
  command?: string;
  cwd?: string;
  attach?: string;
  // True when the "resume" workflow found a terminal already running this session and switched
  // focus to it instead of starting a new one (#578) — distinguishes that from a fresh launch so
  // the client can show "switched to existing terminal" rather than "launched in ...".
  focused?: boolean;
}

/** One agent inside a running herdr session (`terminal/sessions`, #495). */
export interface HerdrAgent {
  /** Stable identity within the session (agent names are not guaranteed unique). */
  id: string;
  /** Display name, e.g. "dev #486". */
  name: string;
  /** Raw herdr agent_status (known values: working | blocked | done | idle). */
  status: string;
  /**
   * True when the PR whose worktree the agent's pane cwd resolves to is merged or
   * closed (#611) — the sidebar grays such rows out. Absent/false when the PR is open
   * or no PR could be resolved: both render as a normal row.
   */
  pull_closed?: boolean;
  /**
   * The PR number whose worktree the agent's pane cwd resolves to, or null when the
   * agent has no linked PR — a "New issue" agent running at the repo root (#633). Since
   * pull_closed can never be true for a no-PR agent, the sidebar instead grays it out
   * (and shows the kill button) once it goes idle. Absent in legacy payloads — treat a
   * missing value the same as null.
   */
  pull?: number | null;
}

/**
 * A running herdr agent's pane, keyed back to the PR whose worktree it's running in
 * (`terminal/sessions`, #579 — the issue-list Herdr badge). `pane_id` is a valid
 * `terminal/focusAgent` target.
 */
export interface HerdrPullWorkspace {
  pull: number;
  pane_id: string;
  /** Raw herdr agent_status (known values: working | blocked | done | idle), same as HerdrAgent.status. */
  status: string;
}

/** A repo's running herdr session and its agents (`terminal/sessions`, #495). */
export interface HerdrRepoSessions {
  repo: string;
  session_name: string;
  agents: HerdrAgent[];
  pull_workspaces: HerdrPullWorkspace[];
}

export interface HerdrSessions {
  repos: HerdrRepoSessions[];
}

/**
 * Recent terminal output for one herdr agent (`terminal/agentRead`, #500), for the
 * sidebar hover preview. `output` is null when herdr isn't running, the session is
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

/** Coding agent `lh dev` launches by default when neither --claude-code nor --codex is passed (#516). */
export type CodingAgent = "claude-code" | "codex";

/** Per-agent settings (#593, #594, #682). */
export interface AgentSettings {
  // Whether the Build button launches this agent with auto mode (#499, #593).
  autoModeOnBuild: boolean;
  // Model this agent launches with when `lh dev --model` isn't passed explicitly (#594).
  model: string;
  // Reasoning effort paired with model in the Settings screen (#682).
  effort: string;
}

/** Instance-level config.json settings (`settings/get`, `settings/update`, #474). */
export interface GlobalSettings {
  // Per-agent settings, keyed by CodingAgent (#593).
  agents: Record<CodingAgent, AgentSettings>;
  // Default coding agent `lh dev` launches (#516).
  codingAgent: CodingAgent;
}

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

/** The GitHub PR a loophub PR was exported to (#406), or null until the export skill records one. */
export type GithubPull = GithubPullWire;

export type Issue = IssueWire;

/** An issue group (#312): a repo-scoped, ordered collection of issues. */
export type IssueGroup = IssueGroupWire;

/**
 * A group an issue belongs to, paired with its ordered members (#314).
 * Returned by `issueGroups/forIssue`; `members` includes the queried issue itself.
 */
export interface IssueGroupWithMembers {
  group: IssueGroup;
  members: Issue[];
}

export type PullRequest = PullWire;

/**
 * A session related to a PR or issue (#298). Mirrors core/serialize.ts relatedSessionJSON: the
 * session metadata plus a runtime-based `resume` verdict. `resumable` true only for the PR's current
 * primary dev session on a resumable runtime; otherwise `reason` says why (e.g. "superseded",
 * "resume-via-pull", "unknown-runtime", "no-session").
 */
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

/** Wire format for GET /events and the /events/stream SSE feed. */
export interface LoopEvent {
  id: number;
  type: string;
  repo?: string;
  actor: string;
  payload: { number?: number; [key: string]: unknown };
  created_at: string;
}
