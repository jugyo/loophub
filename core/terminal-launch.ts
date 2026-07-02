import { createHash } from "node:crypto";

export type TerminalLaunchBackend = "builtin" | "herdr";

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

export function normalizeTerminalLaunchBackend(
  value: unknown,
): TerminalLaunchBackend {
  return value === "herdr" ? "herdr" : "builtin";
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
function displayArg(value: string): string {
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
  workflow?: "issue-dev" | "issue-create" | "resume" | "github-pr-export";
  issueNumber?: number;
  prNumber?: number;
  session?: string;
  cwd?: string;
  // Append `--auto` to the issue-dev launch (#499). Only meaningful for that workflow — the
  // Build button is the only caller that ever passes this, other workflows never do.
  auto?: boolean;
}): string {
  if (input.workflow === "issue-dev" && input.issueNumber) {
    const target = shellArg(`${input.repo}/${input.issueNumber}`);
    return input.auto ? `lh dev ${target} --auto` : `lh dev ${target}`;
  }
  if (input.workflow === "issue-create") {
    // `lh issue new` is the recorded LoopHub entrypoint for the /lh-issue-create workflow.
    return `lh issue new --repo ${shellArg(input.repo)}`;
  }
  if (input.workflow === "github-pr-export" && input.prNumber) {
    return `claude ${shellArg(`/create-github-pr ${input.prNumber}`)}`;
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

export function herdrTabCloseArgv(
  repo: TerminalLaunchRepo,
  tabId: string,
): string[] {
  return ["herdr", "--session", herdrSessionName(repo), "tab", "close", tabId];
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

export function buildHerdrLaunchPlan(input: {
  repo: TerminalLaunchRepo;
  command: string;
  label?: string;
  // Tab to start the agent in. Omitted (tab creation failed) falls back to Herdr's default
  // placement, which splits the focused pane.
  tabId?: string | null;
}): HerdrLaunchPlan {
  const sessionName = herdrSessionName(input.repo);
  const agentName = normalizeAgentName(input.label || "LoopHub workflow");
  const argv = [
    "herdr",
    "--session",
    sessionName,
    "agent",
    "start",
    agentName,
    "--cwd",
    input.repo.local_path,
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
    cwd: input.repo.local_path,
    argv,
  };
}
