import { createHash } from "node:crypto";
import { type CodingAgent, codingAgent } from "./config.ts";

export interface TerminalLaunchRepo {
  full_name: string;
  local_path: string;
}

export interface HerdrLaunchPlan {
  sessionName: string;
  command: string;
  cwd: string;
  argv: string[];
}

function pathSafePart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}

export function herdrSessionName(repo: TerminalLaunchRepo): string {
  const repoPart = repo.full_name.split("/").map(pathSafePart).join("-");
  const hash = createHash("sha256")
    .update(repo.full_name)
    .update("\0")
    .update(repo.local_path)
    .digest("hex")
    .slice(0, 8);
  return `${repoPart}-${hash}`;
}

// Long issue/PR titles baked into a herdr agent name (label) could otherwise appear as a huge or
// multi-line token in the copy-pasteable command line the launch-error dialog shows (see
// herdrCommandLine) — those titles come straight from GitHub issue/PR data, so treat them as
// untrusted: strip control/escape/bidi-override characters that could smuggle terminal escape
// sequences or spoof the displayed text, collapse whitespace, and cap the length. Truncation
// slices by Unicode code point (not UTF-16 code unit) so it can't split a surrogate pair.
const MAX_AGENT_NAME_LENGTH = 80;
// C0/C1 controls (incl. ESC) plus the Unicode bidi-override/isolate control characters
// (U+200E/U+200F LRM/RLM, U+202A-U+202E embedding/override, U+2066-U+2069 isolates).
const UNSAFE_CHARS =
  /[\x00-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

function normalizeAgentName(
  label: string,
  max = MAX_AGENT_NAME_LENGTH,
): string {
  // Replace (not delete) unsafe chars with a space first, so a bare newline/tab or a control
  // char sitting between two separate whitespace runs still leaves a separator behind instead
  // of gluing words together; the single \s+ collapse pass afterward then merges everything
  // (original whitespace + newly-inserted spaces) down to one space.
  const collapsed = label
    .replace(UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  const codePoints = [...collapsed];
  if (codePoints.length <= max) return collapsed;
  return `${codePoints
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Only wraps a token in quotes when the shell would otherwise misparse it (empty, or containing
// anything outside the safe unquoted set). Used for display purposes so the copy-pasteable
// command reads the way a person would actually type it, instead of every single token —
// including plain flags like `--cwd` — being quoted uniformly.
const SAFE_UNQUOTED = /^[A-Za-z0-9_\-./:=@]+$/;
export function displayArg(value: string): string {
  return SAFE_UNQUOTED.test(value) ? value : shellArg(value);
}

// The actual `herdr ...` invocation a caller can paste into their own shell to reproduce a launch
// failure — distinct from HerdrLaunchPlan.command, which is only the inner workflow command herdr
// would run once its session existed (e.g. "lh dev '...'"). That inner command doesn't depend on
// `herdr` at all, so it can't reproduce a herdr-specific failure.
export function herdrCommandLine(plan: HerdrLaunchPlan): string {
  return plan.argv.map(displayArg).join(" ");
}

export function commandForHerdrLaunch(input: {
  repo: string;
  // "issue-dev" (the Build button) has no entry here: worktree/PR provisioning and the herdr
  // launch itself are entirely `lh dev --herdr`'s responsibility (#584) — the server only spawns
  // it directly (see launchIssueDevHerdr in service.ts) rather than building a command string for
  // an agent-start pane the way the other workflows below do.
  workflow?: "issue-create" | "resume" | "github-pr-export";
  prNumber?: number;
  session?: string;
  cwd?: string;
  codingAgent?: CodingAgent;
}): string {
  if (input.workflow === "issue-create") {
    // `lh issue new` is the recorded LoopHub entrypoint for the /lh-issue-create workflow.
    return `lh issue new --repo ${shellArg(input.repo)}`;
  }
  if (input.workflow === "github-pr-export" && input.prNumber) {
    const command = shellArg(`/create-github-pr ${input.prNumber}`);
    return (input.codingAgent ?? codingAgent()) === "codex"
      ? `codex ${command}`
      : `claude ${command}`;
  }
  if (input.workflow === "resume" && input.session) {
    const resume = `claude --resume ${shellArg(input.session)}`;
    return input.cwd ? `cd ${shellArg(input.cwd)} && ${resume}` : resume;
  }
  return "";
}

// Creates the tab the agent will start in (`herdr agent start --tab <ID>`), so launches open
// a new tab instead of splitting the currently focused pane (#489).
export function herdrTabCreateArgv(repo: TerminalLaunchRepo): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "tab",
    "create",
    "--cwd",
    repo.local_path,
    "--no-focus",
  ];
}

// Opens (or reuses) a herdr *workspace* pinned to a git worktree's checkout path, so herdr's own
// workspace/worktree metadata reflects the PR's real worktree instead of a plain tab cd'd there
// by the launched command (#551). The path must already be a registered git worktree — herdr
// replies `worktree_not_found` otherwise, which callers treat like any other best-effort herdr
// failure (fall back to the plain tab-create launch).
export function herdrWorktreeOpenArgv(
  repo: TerminalLaunchRepo,
  worktreeCheckoutPath: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "worktree",
    "open",
    "--path",
    worktreeCheckoutPath,
    "--no-focus",
  ];
}

// `herdr worktree open` reuses an already-open workspace's existing tab/pane rather than handing
// back a fresh empty one (unlike a brand-new open, whose tab/pane are safe to treat like
// `tab create`'s seed pane — see the rootPaneId comment in service.ts). `already_open` tells the
// caller which case it got; `workspace_id` lets it open a genuinely new tab in that workspace via
// herdrTabCreateInWorkspaceArgv when reusing.
export function parseHerdrWorktreeOpenResult(
  stdout: string,
): { alreadyOpen: boolean; workspaceId: string | null } | null {
  try {
    const parsed = JSON.parse(stdout);
    const result = parsed?.result;
    const alreadyOpen = result?.already_open === true;
    const workspaceId = result?.workspace?.workspace_id;
    return {
      alreadyOpen,
      workspaceId:
        typeof workspaceId === "string" && HERDR_ID.test(workspaceId)
          ? workspaceId
          : null,
    };
  } catch {
    return null;
  }
}

// Creates a fresh tab inside an already-open worktree workspace (the `already_open: true` case
// above) instead of splitting whatever pane already occupies it — same #489 rationale as
// herdrTabCreateArgv, scoped to the worktree's own workspace via --workspace.
export function herdrTabCreateInWorkspaceArgv(
  repo: TerminalLaunchRepo,
  workspaceId: string,
  worktreeCheckoutPath: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--cwd",
    worktreeCheckoutPath,
    "--no-focus",
  ];
}

export function herdrTabCloseArgv(
  repo: TerminalLaunchRepo,
  tabId: string,
): string[] {
  return ["herdr", "--session", herdrSessionName(repo), "tab", "close", tabId];
}

// Creates a whole new workspace (rather than a tab in whichever workspace herdr currently treats
// as default) so the New Issue flow gets its own space instead of piling onto the repo's existing
// session (#544). `herdr workspace create` seeds the workspace with one tab and one empty pane,
// reported in the same shape `herdr tab create` uses (`.result.tab.tab_id` /
// `.result.root_pane.pane_id`), so parseHerdrTabId/parseHerdrRootPaneId apply here unchanged.
export function herdrWorkspaceCreateArgv(repo: TerminalLaunchRepo): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "workspace",
    "create",
    "--cwd",
    repo.local_path,
    "--no-focus",
  ];
}

// herdr refuses to close a workspace's last tab (`tab_close_failed`), so cleaning up a failed
// launch that created its own workspace must close the whole workspace, not just its seeded tab.
export function herdrWorkspaceCloseArgv(
  repo: TerminalLaunchRepo,
  workspaceId: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "workspace",
    "close",
    workspaceId,
  ];
}

// Selects the newly created workspace so herdr's active workspace switches to it once the New
// Issue agent is running there (#556) — without this, `herdr workspace create --no-focus` (used
// so creation itself doesn't yank focus mid-launch) leaves the workspace created but unselected,
// and the user has to switch to it manually.
export function herdrWorkspaceFocusArgv(
  repo: TerminalLaunchRepo,
  workspaceId: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "workspace",
    "focus",
    workspaceId,
  ];
}

// Switches herdr's focus to a tab (workspace + tab, in one call) by tab id — brings a newly
// launched agent's pane to the front when it started in its own tab rather than a fresh workspace
// (#625). The New Issue path selects its whole workspace (herdrWorkspaceFocusArgv), but a *reused*
// worktree workspace's freshly added tab — and the plain repo-root tab fallback — are selected this
// way instead: their workspace already existed and isn't this launch's to (re)focus wholesale, so
// only the new tab is brought forward. Both were created with `--no-focus` so creation itself
// wouldn't yank focus mid-launch.
export function herdrTabFocusArgv(
  repo: TerminalLaunchRepo,
  tabId: string,
): string[] {
  return ["herdr", "--session", herdrSessionName(repo), "tab", "focus", tabId];
}

// Switches focus (workspace + tab + pane, in one call) to an already-running agent, by pane id
// (#578's Resume dedup; reused by #579's issue-list Herdr badge). Unlike herdrWorkspaceFocusArgv
// above, this doesn't require the caller to know which workspace/tab the target lives in —
// `herdr agent focus` resolves that itself — which matters for Resume (a session's tab can land
// in any workspace, not just the one currently in front) and equally for the badge (it only knows
// the agent's pane id, not its workspace/tab).
export function herdrAgentFocusArgv(
  repo: TerminalLaunchRepo,
  target: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "agent",
    "focus",
    target,
  ];
}

// Closes the pane an agent is running in (#521's kill button). `herdr` has no direct
// "kill agent" command; closing its pane is the confirmed equivalent.
export function herdrPaneCloseArgv(
  repo: TerminalLaunchRepo,
  paneId: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "pane",
    "close",
    paneId,
  ];
}

// Observed shape is `w1:t2` for tabs and `w1:p1Q` for panes. The strict pattern (in particular
// no leading `-`) keeps a value from child-process stdout from being spliced into an argv as
// something herdr would parse as a flag, or from echoing arbitrary process output back to
// clients via the launch-failure `command` hint. Exported so callers that take an id from
// outside herdr's own output — e.g. killAgent's client-supplied paneId — can apply the same
// guard before it reaches an argv.
export const HERDR_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

// `herdr tab create` prints one JSON object with the new tab at .result.tab.tab_id.
export function parseHerdrTabId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout);
    const tabId = parsed?.result?.tab?.tab_id;
    return typeof tabId === "string" && HERDR_ID.test(tabId) ? tabId : null;
  } catch {
    return null;
  }
}

// `herdr tab create` seeds the new tab with one empty default pane, reported as
// `.result.root_pane.pane_id`. `herdr agent start --tab <id>` splits alongside that pane
// rather than replacing it (#503), so the caller closes it once the agent's own pane exists.
export function parseHerdrRootPaneId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout);
    const paneId = parsed?.result?.root_pane?.pane_id;
    return typeof paneId === "string" && HERDR_ID.test(paneId) ? paneId : null;
  } catch {
    return null;
  }
}

// `herdr workspace create` prints one JSON object with the new workspace at
// `.result.workspace.workspace_id`, needed so a failed launch can close the whole workspace it
// created (herdrWorkspaceCloseArgv) rather than just the tab — closing a workspace's last tab is
// refused by herdr, so a caller that can't determine the workspace id would otherwise be stuck
// falling back to a tab-close that's guaranteed to fail. `.result.tab.workspace_id` reports the
// same id (a workspace-create response seeds exactly one tab, which belongs to the workspace it
// was just created in), so fall back to it if the primary field is ever absent or malformed.
export function parseHerdrWorkspaceId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout);
    // Validate each candidate independently and take the first that passes — a `??` chain would
    // only skip a nullish primary, not one that's present but malformed (empty string, wrong
    // type, a value that fails HERDR_ID), silently discarding a still-usable fallback.
    for (const candidate of [
      parsed?.result?.workspace?.workspace_id,
      parsed?.result?.tab?.workspace_id,
    ]) {
      if (typeof candidate === "string" && HERDR_ID.test(candidate))
        return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

export function buildHerdrLaunchPlan(input: {
  repo: TerminalLaunchRepo;
  command: string;
  label?: string;
  // Tab to start the agent in. Omitted (tab creation failed) falls back to Herdr's default
  // placement, which splits the focused pane.
  tabId?: string | null;
  // Overrides repo.local_path as the agent's --cwd (e.g. a PR worktree, #584's `lh dev --herdr`)
  // without changing the herdr session name, which stays derived from the repo so every launch
  // for it — worktree-pinned or not — lands in the same herdr session.
  cwd?: string;
}): HerdrLaunchPlan {
  const sessionName = herdrSessionName(input.repo);
  const agentName = normalizeAgentName(input.label || "LoopHub workflow");
  const cwd = input.cwd ?? input.repo.local_path;
  const argv = [
    "herdr",
    "--session",
    sessionName,
    "agent",
    "start",
    agentName,
    "--cwd",
    cwd,
    ...(input.tabId ? ["--tab", input.tabId] : []),
    "--no-focus",
    "--",
    "zsh",
    "-lc",
    input.command,
  ];
  return {
    sessionName,
    command: input.command,
    cwd,
    argv,
  };
}
