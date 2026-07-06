// Hand-written types mirroring the LoopHub REST API (see ../../../API.md).
// OpenAPI codegen is out of scope; keep these in sync manually.

export interface Label {
  name: string;
  color?: string;
}

export interface UserRef {
  login: string;
}

/** Summary of the pull request linked to an issue (issue detail response). */
export interface LinkedPull {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  html_url?: string;
  /**
   * Status fields populated on the issue-list response (issueListItemJSON) for
   * the row's PR sub-row. Absent on the issue-detail summary, which does not run
   * the git fan-out.
   */
  working?: boolean;
  review_state?: PullRequest["review_state"];
  mergeable_state?: PullRequest["mergeable_state"];
  additions?: number;
  deletions?: number;
  changed_files?: number;
  /**
   * The GitHub PR this linked PR was exported to (#629), or null/absent. Present on both the
   * issue-list and issue-detail responses; its presence drives the small `GH #N` badge next to
   * the `PR #N` pill. Same shape as `PullRequest.github_pull`.
   */
  github_pull?: GithubPull | null;
}

/** Summary of the issue a PR closes (pull-detail `linked_issue`). */
export interface LinkedIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url?: string;
}

/** A comment on an issue (GET .../issues/{number}/comments). */
export interface IssueComment {
  id: number;
  user: UserRef;
  body: string;
  created_at: string;
  updated_at?: string;
}

/** A submitted review on a PR (GET .../pulls/{number}/reviews). */
export interface PullReview {
  id: number;
  user: UserRef;
  /** Review verdict as stored by the API. */
  state: "PASS" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  /** Commit the review was made against (for grouping by commit; #208). */
  head_sha?: string | null;
  /** Aspect/topic of the review, e.g. design/bug/style/security (#209). */
  topic?: string | null;
  submitted_at: string;
}

/** A line comment on a PR (GET .../pulls/{number}/comments). */
export interface PullLineComment {
  id: number;
  pull_request_review_id?: number;
  user: UserRef;
  path: string;
  line: number | null;
  side?: "LEFT" | "RIGHT";
  body: string;
  created_at: string;
}

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
export interface ReviewNote {
  id: number;
  pull_request: { number: number } | null;
  path: string;
  base_sha: string;
  commit_sha: string;
  body: string;
  user: UserRef;
  created_at: string;
  updated_at: string;
}

// An orchestrator<->subagent handoff (#352), as shown in the PR detail's Handoffs section. `body`
// is inline content (instruction / Verify report) when present; otherwise `src` references a
// canonical copy (plan=PR, diff=commit) and `hash` is its content hash.
export interface Handoff {
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

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  local_path: string;
  archived: boolean;
  archived_at: string | null;
  favorite: boolean;
  favorited_at: string | null;
  created_at: string;
  /**
   * Raw per-repo PR write-action setting (#406): 'merge' | 'github_pr' | null. null = unset, so the
   * effective mode follows the GitHub-remote default. The resolved view (with the default applied)
   * comes from `repos/mergeMode`, not this field.
   */
  merge_mode: MergeMode | null;
}

/** PR-detail write action (#406): loophub's internal merge, or export to GitHub via the skill. */
export type MergeMode = "merge" | "github_pr";

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

export interface SessionUsage {
  session_id: string;
  model: string;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  updated_at: string;
}

export interface SessionSubagentUsage extends SessionUsage {
  source_id: string;
  parent_source_id: string | null;
  label: string | null;
  kind: string;
}

export interface SessionLinkedTarget {
  repo: string;
  kind: "issue" | "pull";
  number: number;
  title: string;
  state: "open" | "closed";
}

/** Agent session list row (`sessions/list`). Usage and links are present when known. */
export interface AgentSession {
  id: string;
  agent: string;
  session?: string | null;
  name?: string;
  runtime?: string;
  kind?: string;
  created_at: string;
  updated_at: string;
  usage?: SessionUsage[];
  subagent_usage?: SessionSubagentUsage[];
  linked_targets?: SessionLinkedTarget[];
}

/** The GitHub PR a loophub PR was exported to (#406), or null until the export skill records one. */
export interface GithubPull {
  number: number;
  url: string;
  branch: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Issue {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  user: UserRef;
  labels: Label[];
  comments: number;
  /**
   * Full comment bodies (author, time, text). Populated only on the issue-detail
   * response (`issues/get`), not the list — so a reader gets the design context left
   * in comments, while the list stays cheap with just the `comments` count (#231).
   */
  comment_list?: IssueComment[];
  created_at: string;
  updated_at: string;
  /** Sessions related to this issue (#298), newest first. Detail response only. */
  related_sessions?: RelatedSession[];
  /** Herdr pane captured from the New Issue flow (#670). Detail response only. */
  herdr_pane?: {
    launch_id: string;
    pane_id: string | null;
    session_name: string | null;
  } | null;
  pull_request?: unknown;
  /**
   * Primary linked PR. On the issue-detail response this is the single open PR;
   * on the issue-list response it is the most-relevant of `linked_pull_requests`.
   */
  linked_pull_request?: LinkedPull | null;
  /**
   * All PRs linked to this issue, most-relevant first. Populated only on the
   * issue-list response (issueListItemJSON); usually 0–1, occasionally more, and
   * the list stacks them vertically.
   */
  linked_pull_requests?: LinkedPull[];
}

/** An issue group (#312): a repo-scoped, ordered collection of issues. */
export interface IssueGroup {
  id: number;
  name: string;
  /** Member count (not the rows). */
  members: number;
  created_at: string;
  updated_at: string;
}

/**
 * A group an issue belongs to, paired with its ordered members (#314).
 * Returned by `issueGroups/forIssue`; `members` includes the queried issue itself.
 */
export interface IssueGroupWithMembers {
  group: IssueGroup;
  members: Issue[];
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  user: UserRef;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  /**
   * True while the PR is WIP (#413): `lh dev` opens the PR at the start of work, so it begins as a
   * draft and is flipped to ready by `lh pr ready-for-review`.
   */
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state: "clean" | "conflict" | "no_commits" | "blocked" | "unknown";
  review_state:
    | "PASSED"
    | "CHANGES_REQUESTED"
    | "READY_FOR_RE_REVIEW"
    | "COMMENTED"
    | "STALE"
    | null;
  changes_addressed_at: string | null;
  changes_addressed_by: string | null;
  merge_commit_sha: string | null;
  main_merge_undo?: {
    can_undo: boolean;
    reason: string | null;
    base_ref: string;
    current_main_sha: string | null;
    merge_commit_sha: string | null;
    previous_main_sha: string | null;
  };
  /** Diff totals for the PR (base...head), aggregated from numstat. */
  additions: number;
  deletions: number;
  changed_files: number;
  /** True when this open PR's lh-dev worktree has real uncommitted changes. */
  working?: boolean;
  created_at: string;
  updated_at: string;
  /** Set on the pull-detail response when the PR closes an issue. */
  linked_issue?: LinkedIssue | null;
  /**
   * Deterministic path of the `lh dev` worktree backing this PR (same convention as the
   * "working" flag). Pure path derivation, so it is the canonical location even if the
   * worktree was pruned; null only for a repo name that can't form a safe path.
   */
  worktree_path?: string | null;
  /** Sessions related to this PR (#298), newest first. Detail response only. */
  related_sessions?: RelatedSession[];
  /** Aggregate token usage for all PR-related sessions with usage data. Detail response only. */
  related_sessions_usage?: RelatedSessionsUsage;
  /**
   * Effective write action for this PR (#406): 'merge' offers the internal Merge control, 'github_pr'
   * offers "Create PR on GitHub" (or "View PR on GitHub" once exported). Resolves the repo's setting
   * against its GitHub remote.
   */
  merge_mode?: MergeMode;
  /** The GitHub PR this PR was exported to (#406), or null. Presence flips Create → View. */
  github_pull?: GithubPull | null;
  /**
   * How long the PR's dev session took (#456), anchored at the primary dev session's start. Detail
   * response only (paired with `related_sessions`). `total` reflects the PR's current state — it
   * keeps growing through "in_progress"/"in_review" until "merged"/"closed" freezes it.
   * `implementation` (start → first ready_for_review event) and `review` (that event → merge/close)
   * split the total into the pre- and post-review-handoff phases; `review` is null until the PR has
   * reached ready_for_review at least once. Everything is null when there is no dev session to
   * anchor the calculation — the frontend renders that as "N/A".
   */
  work_duration?: {
    total: {
      seconds: number | null;
      basis: "merged" | "closed" | "in_review" | "in_progress" | null;
    };
    implementation: { seconds: number | null; done: boolean } | null;
    review: { seconds: number | null; done: boolean } | null;
  };
}

/**
 * A session related to a PR or issue (#298). Mirrors core/serialize.ts relatedSessionJSON: the
 * session metadata plus a runtime-based `resume` verdict. `resumable` true only for the PR's current
 * primary dev session on a resumable runtime; otherwise `reason` says why (e.g. "superseded",
 * "resume-via-pull", "unknown-runtime", "no-session").
 */
export interface RelatedSession {
  id: string;
  agent: string;
  session: string;
  kind?: string;
  runtime?: string;
  name?: string;
  created_at: string;
  updated_at: string;
  /** When this session was linked to the PR/issue. */
  linked_at: string | null;
  /** Model-level token usage and API-equivalent cost, when synced for this session. */
  usage?: SessionUsage[];
  /** Subagent-level usage detail; drill-down only, not added to aggregate totals again. */
  subagent_usage?: SessionSubagentUsage[];
  resume: { resumable: boolean; reason?: string };
}

export interface RelatedSessionsUsage {
  sessions_with_usage: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Null when any included usage row has an unknown model price. */
  cost_usd: number | null;
  has_unknown_cost: boolean;
}

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
