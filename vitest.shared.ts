// Tests create isolated databases that do not contain the invoking workflow's
// session. Individual tests that exercise attribution set this env explicitly.
delete process.env.LOOPHUB_SESSION_ID;

export const allTestFiles = [
  "vitest.config.test.ts",
  "scripts/**/*.test.ts",
  "core/**/*.test.ts",
  "cli/**/*.test.ts",
  "web/server/**/*.test.ts",
  "worker/**/*.test.ts",
];

// These files create or operate on real git repositories, commits, branches,
// or worktrees. Keep the list explicit so newly added integration coverage is
// visible during review instead of being classified by an opaque convention.
export const gitIntegrationTestFiles = [
  "cli/commands/workspace.test.ts",
  "cli/context.test.ts",
  "cli/dev.test.ts",
  "cli/issue-new.test.ts",
  "cli/issue-update.test.ts",
  "cli/notification-send.test.ts",
  "cli/pr-comment.test.ts",
  "cli/pr-feedback.test.ts",
  "cli/pr-record-github-pr.test.ts",
  "cli/pr-update.test.ts",
  "cli/workflow-start.test.ts",
  "cli/worktree-prune.test.ts",
  "core/linked-pulls.test.ts",
  "core/dashboard.test.ts",
  "core/dev.test.ts",
  "core/git.test.ts",
  "core/github-feedback-sync.test.ts",
  "core/github-issue-service.test.ts",
  "core/github-merge-sync.test.ts",
  "core/github-pr-status-service.test.ts",
  "core/github-pull-service.test.ts",
  "core/handoffs-service.test.ts",
  "core/herdr-sessions-service.test.ts",
  "core/issues-service.test.ts",
  "core/notifications-service.test.ts",
  "core/number-worktree-regression.test.ts",
  "core/pull-base.test.ts",
  "core/pull-conflict-events.test.ts",
  "core/pull-debug.test.ts",
  "core/pull-file-at-ref.test.ts",
  "core/pull-merge-no-commits.test.ts",
  "core/pull-work-duration.test.ts",
  "core/repos-service.test.ts",
  "core/service/diff-feedback.test.ts",
  "core/service/pulls.test.ts",
  "core/service/reviews.test.ts",
  "core/service/transaction-boundaries.test.ts",
  "core/service/workspaces.test.ts",
  "core/sessions-service.test.ts",
  "core/settings-service.test.ts",
  "core/terminal-launch-service.test.ts",
  "core/terminal-service.test.ts",
  "core/terminal/session-projection.test.ts",
  "core/workflow-run-progress.test.ts",
  "core/workflow-runs-service.test.ts",
  "core/worktrees.test.ts",
  "web/server/http.test.ts",
  "web/server/rpc.test.ts",
  "worker/maintenance.test.ts",
  "worker/runner.test.ts",
];

const workerLimits = {
  // Integration tests launch git/CLI subprocesses and open isolated SQLite
  // databases. Capping workers avoids oversubscribing shared host resources.
  minWorkers: 1,
  maxWorkers: 4,
};

export const fastTestConfig = {
  include: allTestFiles,
  exclude: gitIntegrationTestFiles,
  ...workerLimits,
};

export const integrationTestConfig = {
  include: gitIntegrationTestFiles,
  exclude: [],
  ...workerLimits,
};

export const fullTestConfig = {
  include: allTestFiles,
  // The include list is exhaustive; clear Vitest's default config exclusion so
  // the co-located vitest.config.test.ts contract runs with the suite.
  exclude: [],
  ...workerLimits,
};
