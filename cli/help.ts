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
  --body <text>           Markdown issue body; @file reads a file and - reads stdin.
  --label <name,...>      Comma-separated labels.
  --ac <text>             Structured acceptance criterion (repeatable, non-blank).
  --parent <number>       Parent issue number; the new issue is created as a sub-issue.
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

const ISSUE_NEW_DETAILS = `

Usage:
  lh issue new [options]

Options:
  --claude-code          Launch Claude Code.
  --codex                Launch Codex.
  --grok                 Launch Grok Build.
  --opencode             Launch OpenCode.
  --model <name>         Override the selected runtime's default model.
  --effort <level>       Override the selected runtime's reasoning effort when supported.
  --target-branch <ref>  Carry an existing target branch into the issue-filing session.
  --prompt <text>        Replace the default issue-filing prompt.
  --repo <owner/name>    Repository (defaults to the repository at the current path).
  --help                 Show this help without launching an agent or changing the database.

Constraints:
  Runtime flags are mutually exclusive. When omitted, the effective repository or application
  Coding agent setting is used.`;

const ISSUE_VIEW_DETAILS = `

Usage:
  lh issue view <number> [options]

Options:
  --include-archived    Include archived comments in the comment list (omitted by default).
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --json                Print the issue, comments, acceptance criteria, and linked PR as JSON.
  --help                Show this help without reading the database.`;

const ISSUE_COMMENT_DETAILS = `

Usage:
  lh issue comment <number> --body <text> [options]
  lh issue comment archive|unarchive <comment> --issue <number> [options]

Options:
  --body <text>         Comment body; @file reads a file and - reads stdin.
  --issue <number>      Target issue (required for archive and unarchive).
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --session-id <uuid>   Attribute the comment to a registered agent session.
  --json                Print the created or updated comment as JSON.
  --help                Show this help without changing the database.

Constraints:
  An archived comment stays on the issue, collapsed, and is left out of the comment list
  unless \`lh issue view --include-archived\` asks for it.`;

const ISSUE_SUB_DETAILS = `

Usage:
  lh issue sub list <parent> [options]
  lh issue sub add <parent> <child> [options]
  lh issue sub remove <child> [options]
  lh issue sub reorder <parent> --order <child,...> [options]

Options:
  --order <child,...>    Complete ordered list of sub-issue numbers (reorder only).
  --repo <owner/name>    Repository (defaults to the repository at the current path).
  --json                 Print the result as JSON.
  --help                 Show this help without changing the database.`;

const SESSION_REGISTER_DETAILS = `

Usage:
  lh session register --id <uuid> --agent <kind> --session <runtime-id> [options]

Options:
  --id <uuid>           LoopHub session identifier.
  --agent <kind>        Agent or launcher kind.
  --session <id>        Runtime session identifier.
  --name <text>         Human-readable session name.
  --runtime <runtime>   Runtime: claude-code, codex, grok, or opencode.
  --model <name>        Runtime model identifier.
  --kind <kind>         Session kind such as dev, review, or issue-create.
  --help                Show this help without changing the database.`;

const PR_VIEW_DETAILS = `

Usage:
  lh pr view <number> [options]

Options:
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --json                Print the pull request, comments, commits, and linked issue as JSON.
  --help                Show this help without reading the database.`;

const PR_UPDATE_DETAILS = `

Usage:
  lh pr update <number> [options]

Options:
  --title <text>        New pull request title.
  --body <text>         New Markdown body; @file reads a file and - reads stdin.
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --session-id <uuid>   Attribute the update to a registered agent session.
  --json                Print the updated pull request as JSON.
  --help                Show this help without changing the database.

Constraints:
  At least one of --title and --body is required.`;

const PR_COMMENT_DETAILS = `

Usage:
  lh pr comment <number> --body <text> [options]
  lh pr comment react <comment> --pr <number> --emoji <emoji> [options]

Options:
  --body <text>         Comment body; @file reads a file and - reads stdin.
  --pr <number>         Target pull request (required for react).
  --emoji <emoji>       Reaction emoji (required for react).
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --session-id <uuid>   Attribute the comment to a registered agent session.
  --json                Print the created comment or reaction as JSON.
  --help                Show this help without changing the database.`;

const PR_FEEDBACK_DETAILS = `

Usage:
  lh pr feedback list <number> [options]
  lh pr feedback pending <number> --run <id> [options]
  lh pr feedback create <number> --path <path> --side LEFT|RIGHT
    --start-line <n> --end-line <n> --body <text> [options]
  lh pr feedback view <conversation> --pr <number> [options]
  lh pr feedback reply <conversation> --pr <number> --body <text> [options]
  lh pr feedback archive|unarchive <conversation> --pr <number> [options]
  lh pr feedback react <message> --pr <number> --emoji <emoji> [options]

Options:
  --pr <number>         Target pull request (required by the conversation-scoped actions).
  --run <id>            Workflow run whose unanswered conversations pending returns.
  --body <text>         Comment body for create and reply; @file reads a file and - reads stdin.
  --base-sha <sha>      Base commit the anchor was taken against (create).
  --head-sha <sha>      Head commit the anchor was taken against (create).
  --path <path>         Anchored file path (create).
  --side <LEFT|RIGHT>   Anchored diff side (create).
  --start-line <n>      First anchored line (create).
  --end-line <n>        Last anchored line (create).
  --emoji <emoji>       Reaction emoji (react).
  --context <lines>     Diff context radius around the anchor.
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --session-id <uuid>   Attribute the write to a registered agent session.
  --json                Print the conversation or conversation list as JSON.
  --help                Show this help without changing the database.`;

const PR_REVIEW_DETAILS = `

Usage:
  lh pr review submit <number> [options]
  lh pr review view <number> --review <id> [options]

A review is written only by submit; lh pr review <number> on its own writes nothing.`;

const PR_REVIEW_SUBMIT_DETAILS = `

Usage:
  lh pr review submit <number> [options]

Options:
  --event <verdict>       Review verdict: comment (default), pass, or request_changes.
  --body <text>           Review summary; @file reads a file and - reads stdin.
  --commit <sha>          Pin the review to this head commit (defaults to the current PR head).
  --comments <json|file>  Line comments as [{ "path", "line", "side"?, "body" }].
  --ac-results <json|file>
                          Acceptance-criterion grades as
                          [{ "criterion_id", "verdict", "note"? }].
  --model <name>          Record the model that produced the review.
  --repo <owner/name>     Repository (defaults to the repository at the current path).
  --session-id <uuid>     Attribute the review to a registered agent session.
  --json                  Print the submitted review as JSON.
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
  --body <text>          Response body (required for add); @file reads a file and - reads stdin.
  --repo <owner/name>    Repository (defaults to the repository at the current path).
  --session-id <uuid>    Attribute the response to a registered agent session.
  --json                 Print the response or response list as JSON.
  --help                 Show this help without changing the database.`;

const WORKFLOW_PARENT_READY_DETAILS = `

Usage:
  lh workflow parent-ready <run> [options]

Options:
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --json                Print the ready signal and any instruction it releases as JSON.
  --help                Show this help without changing the database.`;

const WORKFLOW_TURN_DONE_DETAILS = `

Usage:
  lh workflow turn done [options]

Options:
  --run <id>            Workflow run (required).
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --session-id <uuid>   Attribute the declaration to a registered agent session.
  --json                Print the recorded turn as JSON.
  --help                Show this help without changing the database.`;

const WORKFLOW_ESCALATE_DETAILS = `

Usage:
  lh workflow escalate --reason <text> [options]

Options:
  --reason <text|@file|-> Short summary; @file reads a file and - reads stdin (required).
  --run <id>            Workflow run (required).
  --repo <owner/name>   Repository (defaults to the repository at the current path).
  --session-id <uuid>   Attribute the escalation to a registered agent session.
  --json                Print the recorded escalation as JSON.
  --help                Show this help without changing the database.`;

const WORKFLOW_INSTRUCTION_DETAILS = `

Usage:
  lh workflow instruction <run> [--repo <owner/name>]
    (--event <id> --requires-changes true|false | --note <text|->) [--json]

Options:
  --event <id>              The event whose GitHub references the parent read.
  --requires-changes <bool> The parent's verdict on those references.
  --note <text|@file|->     A direct human instruction; @file reads a file and - reads stdin.
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
  {
    path: ["issue", "new"],
    description: "Create an issue interactively.",
    details: ISSUE_NEW_DETAILS,
  },
  {
    path: ["issue", "create"],
    description: "Create an issue.",
    details: ISSUE_CREATE_DETAILS,
  },
  { path: ["issue", "import"], description: "Import a GitHub issue." },
  { path: ["issue", "update"], description: "Update an issue." },
  {
    path: ["issue", "comment"],
    description: "Comment on an issue.",
    details: ISSUE_COMMENT_DETAILS,
  },
  { path: ["issue", "close"], description: "Close an issue." },
  { path: ["issue", "label"], description: "Add a label to an issue." },
  {
    path: ["issue", "sub"],
    description: "Manage issue hierarchy.",
    details: ISSUE_SUB_DETAILS,
  },
  { path: ["session"], description: "Manage agent sessions." },
  {
    path: ["session", "register"],
    description: "Register an agent session.",
    details: SESSION_REGISTER_DETAILS,
  },
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
  {
    path: ["pr", "view"],
    description: "Show a pull request.",
    details: PR_VIEW_DETAILS,
  },
  { path: ["pr", "diff"], description: "Show a pull request diff." },
  { path: ["pr", "create"], description: "Create a pull request." },
  {
    path: ["pr", "update"],
    description: "Update a pull request.",
    details: PR_UPDATE_DETAILS,
  },
  {
    path: ["pr", "comment"],
    description: "Comment on a pull request.",
    details: PR_COMMENT_DETAILS,
  },
  {
    path: ["pr", "feedback"],
    description: "Manage pull request diff feedback conversations.",
    details: PR_FEEDBACK_DETAILS,
  },
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
    description: "Submit or read pull request reviews.",
    details: PR_REVIEW_DETAILS,
  },
  {
    path: ["pr", "review", "submit"],
    description: "Submit a pull request review.",
    details: PR_REVIEW_SUBMIT_DETAILS,
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
    path: ["workflow", "run", "recover-launch"],
    description: "Record and release an orphaned step launch.",
  },
  {
    path: ["workflow", "parent-ready"],
    description: "Declare the parent agent is up and reads its pane.",
    details: WORKFLOW_PARENT_READY_DETAILS,
  },
  {
    path: ["workflow", "turn", "done"],
    description: "Declare an Execute turn done (payload-less).",
    details: WORKFLOW_TURN_DONE_DETAILS,
  },
  {
    path: ["workflow", "escalate"],
    description: "Declare that an Execute child needs human guidance.",
    details: WORKFLOW_ESCALATE_DETAILS,
  },
  {
    path: ["workflow", "deliver"],
    description:
      "Deliver an instruction to a workflow agent (default: executor).",
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

export function resolveCommandHelp(
  positionals: readonly string[],
): CommandHelp | undefined {
  const isPrefix = ({ path }: CommandHelp) =>
    path.every((part, index) => positionals[index] === part);
  const hasChildren = ({ path }: CommandHelp) =>
    commandHelp.some(
      ({ path: candidate }) =>
        candidate.length > path.length &&
        path.every((part, index) => candidate[index] === part),
    );
  return (
    commandHelp.find(
      (entry) => entry.path.length === positionals.length && isPrefix(entry),
    ) ??
    [...commandHelp]
      .sort((a, b) => b.path.length - a.path.length)
      .find((entry) => isPrefix(entry) && !hasChildren(entry))
  );
}

export function printCommandHelp(positionals: readonly string[]): boolean {
  const match = resolveCommandHelp(positionals);
  if (!match) return false;

  console.log(
    `lh ${match.path.join(" ")} — ${match.description}${match.details ?? ""}`,
  );
  return true;
}
