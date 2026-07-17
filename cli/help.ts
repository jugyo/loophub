export type CommandHelp = {
  path: readonly string[];
  description: string;
};

export const commandHelp: readonly CommandHelp[] = [
  { path: ["info"], description: "Show the resolved LoopHub environment." },
  {
    path: ["resume"],
    description: "Resume the primary development session for a pull request.",
  },
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
  { path: ["issue", "view"], description: "Show an issue." },
  { path: ["issue", "new"], description: "Create an issue interactively." },
  { path: ["issue", "create"], description: "Create an issue." },
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
  { path: ["pr", "review"], description: "Submit a pull request review." },
  {
    path: ["pr", "ready-for-review"],
    description: "Mark a pull request ready for review.",
  },
  { path: ["pr", "close"], description: "Close a pull request." },
  { path: ["pr", "reopen"], description: "Reopen a pull request." },
  { path: ["handoff"], description: "Manage agent handoffs." },
  { path: ["handoff", "record"], description: "Record an agent handoff." },
  { path: ["handoff", "list"], description: "List agent handoffs." },
  { path: ["inbox"], description: "Manage Inbox messages." },
  { path: ["inbox", "send"], description: "Send an Inbox message." },
  { path: ["inbox", "read"], description: "Mark an Inbox message as read." },
  {
    path: ["inbox", "unread"],
    description: "Mark an Inbox message as unread.",
  },
  { path: ["inbox", "archive"], description: "Archive an Inbox message." },
  { path: ["inbox", "unarchive"], description: "Unarchive an Inbox message." },
  { path: ["inbox", "delete"], description: "Delete an Inbox message." },
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

  console.log(`lh ${match.path.join(" ")} — ${match.description}`);
  return true;
}
