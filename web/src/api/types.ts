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
  state: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
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

export interface Repo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  local_path: string;
  archived: boolean;
  archived_at: string | null;
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
  created_at: string;
  updated_at: string;
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

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  user: UserRef;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: "clean" | "dirty" | "no_commits" | "blocked" | "unknown";
  review_state:
    | "APPROVED"
    | "CHANGES_REQUESTED"
    | "READY_FOR_RE_REVIEW"
    | "COMMENTED"
    | "STALE"
    | null;
  changes_addressed_at: string | null;
  changes_addressed_by: string | null;
  merge_commit_sha: string | null;
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

/** One open unmerged PR plus the repo it belongs to (dashboard/overview). */
export interface DashboardPullItem {
  repo: RepoRef;
  pull: PullRequest;
}

/** Cross-repo top-page overview (dashboard/overview). */
export interface DashboardOverview {
  issues: DashboardIssueItem[];
  pulls: DashboardPullItem[];
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
