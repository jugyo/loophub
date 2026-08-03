export type CommandHelp = {
  path: readonly string[];
  description: string;
  details?: string;
};

const ISSUE_CREATE_DETAILS = `

Usage:
  lh issue create --title <text> [options]

Options:
  --title <text>          Issue title (required, non-empty).
  --body <text>           Markdown issue body.
  --label <name,...>      Comma-separated labels.
  --ac <text>             Structured acceptance criterion (repeatable, non-blank).
  --workspace <name>      Active registered workspace whose branch becomes the target.
  --target-branch <ref>   Existing branch or revision expression used as the target.
  --repo <owner/name>     Repository (defaults to the repository at the current path).
  --session-id <uuid>     Attribute the creation to a registered agent session.
  --json                  Print the created issue as JSON.
  --help                  Show this help without creating or changing the database.

Acceptance criteria:
  Each --ac value is saved as one structured acceptance_criteria entry, in command-line order.
  Blank --ac values are ignored. Keep acceptance criteria out of --body: do not add an
  "Acceptance criteria" heading or duplicate checklist there. Acceptance criteria written in
  --body remain ordinary Markdown and are not parsed into structured acceptance_criteria.

Constraints:
  --workspace and --target-branch cannot be combined. The workspace must be active and registered.
  The target branch must resolve to an existing revision; this command does not create branches.

Example:
  lh issue create --title "Keep exports deterministic" --body "## Goal

Preserve input order."
    --ac "Exports retain input order" --ac "Repeated exports are byte-identical"`;

const ISSUE_VIEW_DETAILS = `

Usage:
  lh issue view <number> [options]

Options:
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --json                Print the issue, comments, acceptance criteria, and linked PR as JSON.
  --help                Show this help without reading the database.`;

const PR_REVIEW_DETAILS = `

Usage:
  lh pr review <number> [options]
  lh pr review view <number> --review <id> [options]

Options:
  --review <id>          Target review (required for view).
  --event <verdict>       Review verdict: comment (default), pass, or request_changes.
  --body <text>           Review summary.
  --commit <sha>          Pin the review to this head commit (defaults to the current PR head).
  --comments <json|file>  Line comments as [{ "path", "line", "side"?, "body" }].
  --ac-results <json|file>
                          Acceptance-criterion grades as
                          [{ "criterion_id", "verdict", "note"? }].
  --model <name>          Record the model that produced the review.
  --repo <owner/name>     Repository (defaults to the repository at the current path).
  --session-id <uuid>     Attribute the review to a registered agent session.
  --json                  Print the submitted review or review detail as JSON.
  --help                  Show this help without changing the database.`;

const PR_REVIEW_VIEW_DETAILS = `

Usage:
  lh pr review view <number> --review <id> [options]

Options:
  --review <id>       Target review (required).
  --repo <owner/name> Repository (defaults to the repository at the current path).
  --json              Print the review and all of its line comments as JSON.
  --help              Show this help without changing the database.`;

const PR_REVIEW_RESPONSE_DETAILS = `

Usage:
  lh pr review-response add <number> --review <id> [options]
  lh pr review-response list <number> --review <id> [options]

Options:
  --review <id>          Target review (required).
  --review-comment <id>  Optional review comment within the target review.
  --body <text>          Response body (required for add).
  --repo <owner/name>    Repository (defaults to the repository at the current path).
  --session-id <uuid>    Attribute the response to a registered agent session.
  --json                 Print the response or response list as JSON.
  --help                 Show this help without changing the database.`;

const WORKFLOW_INSTRUCTION_DETAILS = `

Usage:
  lh workflow instruction <run> [--repo <owner/name>]
    (--event <id> --requires-changes true|false | --note <text|->) [--json]

Options:
  --event <id>              The event whose GitHub references the parent read.
  --requires-changes <bool> The parent's verdict on those references.
  --note <text|->           A direct human instruction; - reads the instruction from stdin.
  --repo <owner/name>       Repository (defaults to the repository at the current path).
  --json                    Print the action, observations, and structured instructions as JSON.
  --help                    Show this help without reading or changing the database.

Constraints:
  --event and --note are mutually exclusive, and exactly one of them is required.
  --event requires --requires-changes.`;

export const commandHelp: readonly CommandHelp[] = [
  { path: ["info"], description: "Show the resolved LoopHub environment." },
  { path: ["repo"], description: "Manage registered repositories." },
  { path: ["repo", "add"], description: "Register a local repository." },
  { path: ["repo", "list"], description: "List registered repositories." },
  { path: ["repo", "archive"], description: "Archive a repository." },
  { path: ["repo", "unarchive"], description: "Unarchive a repository." },
  {
    path: ["repo", "favorite"],
    description: "Mark a repository as a favorite.",
  },
  {
    path: ["repo", "unfavorite"],
    description: "Remove a repository from favorites.",
  },
  { path: ["repo", "update"], description: "Update a registered repository." },
  { path: ["repo", "remove"], description: "Remove a registered repository." },
  {
    path: ["repo", "merge-mode"],
    description: "Set a repository's pull request merge mode.",
  },
  { path: ["issue"], description: "Manage issues." },
  {
    path: ["issue", "search"],
    description: "Search issues and pull requests in a repository.",
  },
  { path: ["issue", "list"], description: "List issues." },
  {
    path: ["issue", "view"],
    description: "Show an issue.",
    details: ISSUE_VIEW_DETAILS,
  },
  { path: ["issue", "new"], description: "Create an issue interactively." },
  {
    path: ["issue", "create"],
    description: "Create an issue.",
    details: ISSUE_CREATE_DETAILS,
  },
  { path: ["issue", "import"], description: "Import a GitHub issue." },
  { path: ["issue", "update"], description: "Update an issue." },
  { path: ["issue", "comment"], description: "Comment on an issue." },
  { path: ["issue", "close"], description: "Close an issue." },
  { path: ["issue", "label"], description: "Add a label to an issue." },
  { path: ["session"], description: "Manage agent sessions." },
  { path: ["session", "register"], description: "Register an agent session." },
  { path: ["session", "list"], description: "List agent sessions." },
  { path: ["session", "usage"], description: "Show recorded session usage." },
  {
    path: ["session", "usage", "confirm"],
    description: "Show recorded session usage for confirmation.",
  },
  {
    path: ["session", "usage", "sync"],
    description: "Synchronize session usage.",
  },
  {
    path: ["session", "usage", "recalculate"],
    description: "Recalculate all available session usage.",
  },
  { path: ["attachment"], description: "Manage attachments." },
  { path: ["attachment", "add"], description: "Upload attachment files." },
  { path: ["pr"], description: "Manage pull requests." },
  { path: ["pr", "list"], description: "List pull requests." },
  { path: ["pr", "view"], description: "Show a pull request." },
  { path: ["pr", "diff"], description: "Show a pull request diff." },
  { path: ["pr", "create"], description: "Create a pull request." },
  { path: ["pr", "update"], description: "Update a pull request." },
  { path: ["pr", "comment"], description: "Comment on a pull request." },
  { path: ["pr", "merge"], description: "Merge a pull request." },
  {
    path: ["pr", "record-github-pr"],
    description: "Record a linked GitHub pull request.",
  },
  {
    path: ["pr", "create-github-pr"],
    description: "Create a linked GitHub pull request.",
  },
  {
    path: ["pr", "push-github-pr"],
    description: "Push a pull request branch to GitHub.",
  },
  {
    path: ["pr", "review"],
    description: "Submit a pull request review.",
    details: PR_REVIEW_DETAILS,
  },
  {
    path: ["pr", "review", "view"],
    description: "Show a pull request review and all of its line comments.",
    details: PR_REVIEW_VIEW_DETAILS,
  },
  {
    path: ["pr", "review-response"],
    description: "Add or list responses linked to a pull request review.",
    details: PR_REVIEW_RESPONSE_DETAILS,
  },
  { path: ["pr", "close"], description: "Close a pull request." },
  { path: ["pr", "reopen"], description: "Reopen a pull request." },
  { path: ["handoff"], description: "Manage agent handoffs." },
  { path: ["handoff", "record"], description: "Record an agent handoff." },
  { path: ["handoff", "list"], description: "List agent handoffs." },
  { path: ["notification"], description: "Manage topbar notifications." },
  {
    path: ["notification", "send"],
    description: "Send a topbar notification.",
  },
  { path: ["workspace"], description: "Manage integration workspaces." },
  {
    path: ["workspace", "create"],
    description: "Create a branch-backed workspace.",
  },
  {
    path: ["workspace", "list"],
    description: "List active workspaces.",
  },
  {
    path: ["workspace", "archive"],
    description: "Archive a workspace without deleting its branch.",
  },
  { path: ["worktree"], description: "Manage pull request worktrees." },
  {
    path: ["worktree", "prune"],
    description: "Prune completed pull request worktrees.",
  },
  { path: ["herdr"], description: "Show the repository's herdr session." },
  {
    path: ["herdr", "focus"],
    description: "Focus the herdr pane for a pull request.",
  },
  { path: ["retro"], description: "Manage pull request retrospectives." },
  {
    path: ["retro", "create"],
    description: "Create a pull request retrospective.",
  },
  { path: ["retro", "list"], description: "List pull request retrospectives." },
  { path: ["retro", "view"], description: "Show a retrospective." },
  {
    path: ["retro", "pending"],
    description: "List merged pull requests awaiting retrospectives.",
  },
  {
    path: ["sync"],
    description: "Detect and publish pull request head updates.",
  },
  { path: ["events"], description: "Show a snapshot of LoopHub events." },
  { path: ["workflow"], description: "Manage workflows and workflow runs." },
  { path: ["workflow", "list"], description: "List workflows." },
  { path: ["workflow", "view"], description: "Show a workflow." },
  { path: ["workflow", "create"], description: "Create a workflow." },
  { path: ["workflow", "update"], description: "Update a workflow." },
  { path: ["workflow", "archive"], description: "Archive a workflow." },
  { path: ["workflow", "delete"], description: "Delete a workflow." },
  { path: ["workflow", "start"], description: "Start a workflow run." },
  { path: ["workflow", "launch-step"], description: "Launch a workflow step." },
  { path: ["workflow", "run"], description: "Manage a workflow run." },
  {
    path: ["workflow", "run", "update"],
    description: "Update a workflow run.",
  },
  {
    path: ["workflow", "turn", "done"],
    description: "Declare an Execute turn done (payload-less).",
  },
  {
    path: ["workflow", "escalate"],
    description: "Declare that an Execute child needs human guidance.",
  },
  {
    path: ["workflow", "deliver"],
    description: "Deliver an instruction to the latest Execute child.",
  },
  {
    path: ["workflow", "escalate-human"],
    description: "Notify a human about a workflow escalation.",
  },
  {
    path: ["workflow", "instruction"],
    description:
      "Submit a parent input and return the instruction it produces.",
    details: WORKFLOW_INSTRUCTION_DETAILS,
  },
  {
    path: ["workflow", "step"],
    description: "Preview a workflow step input or observe step status.",
  },
  {
    path: ["workflow", "step", "input"],
    description: "Preview a workflow step input.",
  },
  {
    path: ["workflow", "step", "status"],
    description: "Show workflow step completion status.",
  },
];

export function printCommandHelp(positionals: readonly string[]): boolean {
  const isPrefix = ({ path }: CommandHelp) =>
    path.every((part, index) => positionals[index] === part);
  const hasChildren = ({ path }: CommandHelp) =>
    commandHelp.some(
      ({ path: candidate }) =>
        candidate.length > path.length &&
        path.every((part, index) => candidate[index] === part),
    );
  const match =
    commandHelp.find(
      (entry) => entry.path.length === positionals.length && isPrefix(entry),
    ) ??
    [...commandHelp]
      .sort((a, b) => b.path.length - a.path.length)
      .find((entry) => isPrefix(entry) && !hasChildren(entry));
  if (!match) return false;

  console.log(
    `lh ${match.path.join(" ")} — ${match.description}${match.details ?? ""}`,
  );
  return true;
}
