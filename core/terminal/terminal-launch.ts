import { createHash } from "node:crypto";
import { type CodingAgent, codingAgent } from "../config.ts";
import {
  buildRuntimeArgs,
  buildRuntimeFlags,
  runtimePrompt,
} from "../runtime-args.ts";
import { RUNTIMES, type RuntimeBin } from "../runtimes.ts";
import type { WorkflowStep } from "../workflow/compose.ts";
import { workflowStepHerdrAgentName } from "../workflow/herdr-agents.ts";
import { herdrPromptPaneArgs } from "./herdr-paste.ts";

export interface TerminalLaunchRepo {
  full_name: string;
  local_path: string;
}

// Placeholder token substituted with the pane id created by a plan's `paneArgv` step. herdr 0.7.5's
// `agent start` no longer creates the pane it starts in (it attaches to an existing one), so a
// launch is a small ordered script rather than a single argv — and the pane id only exists once the
// first step has run. HERDR_ID rejects `{`/`}`, so this token can never collide with a real id.
export const HERDR_PANE_PLACEHOLDER = "{pane}";

// One herdr launch, as the ordered calls it now takes. `paneArgv` creates the pane (its stdout
// carries the pane id); `renameArgv` gives that pane the human-readable label LoopHub later parses
// back out of `pane list`; `argv` starts the actual work in it. Both later steps carry
// HERDR_PANE_PLACEHOLDER wherever the pane id belongs — executeHerdrLaunchPlan substitutes it.
export interface HerdrLaunchPlan {
  sessionName: string;
  // The herdr 0.7.5 agent name: a strict slug (`^[a-z][a-z0-9_-]{0,31}$`), unique within the
  // session. Distinct from `label` — pre-0.7.5 herdr had one free-form name that served as both.
  agentName: string;
  // The display label written to the pane. This is the string LoopHub's own parsers (workflow agent
  // names, the sidebar) read back, so it keeps the exact pre-0.7.5 wording.
  label: string;
  command: string;
  cwd: string;
  paneArgv: string[];
  renameArgv: string[];
  argv: string[];
  // The prompt delivery, as the pair of `herdr` calls that paste it and press Enter. Empty when the
  // launch carries no prompt. Separate from `argv` because herdr 0.7.5's `agent start` refuses any
  // argument containing a newline, and every LoopHub prompt is multi-line: the runtime is started
  // with its flags only, then the prompt goes into the running agent's input.
  promptArgv: string[][];
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

export function normalizeAgentName(
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

// herdr 0.7.5 validates the `agent start` name as `^[a-z][a-z0-9_-]{1,32}$` and rejects a name
// already taken in the session (`invalid_agent_name` / `agent_name_taken`), where pre-0.7.5 herdr
// accepted the free-form label as the name. So the label is no longer usable as the name: derive a
// slug from it for identity and keep the label itself on the pane (see herdrPaneRenameArgv).
//
// `seed` makes the result unique — the pane id the agent starts in, which herdr guarantees is
// unique within the session. Without it two launches sharing a label (two "New issue" agents, a
// relaunched workflow child) would collide on the second `agent start`. Labels that slugify to
// nothing (a fully non-ASCII issue title) still produce a usable name because the seeded suffix
// always remains.
const MAX_AGENT_SLUG_LENGTH = 32;
const SLUG_SUFFIX_LENGTH = 8;
export function herdrAgentSlug(label: string, seed: string): string {
  const suffix = createHash("sha256")
    .update(label)
    .update("\0")
    .update(seed)
    .digest("hex")
    .slice(0, SLUG_SUFFIX_LENGTH);
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, MAX_AGENT_SLUG_LENGTH - SLUG_SUFFIX_LENGTH - 1)
    .replace(/-+$/, "");
  return base ? `${base}-${suffix}` : `a-${suffix}`;
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

// The actual `herdr ...` invocations a caller can paste into their own shell to reproduce a launch
// failure — distinct from HerdrLaunchPlan.command, which is only the inner workflow command herdr
// would run once its session existed (e.g. "lh issue new '...'"). That inner command doesn't depend
// on `herdr` at all, so it can't reproduce a herdr-specific failure. Since herdr 0.7.5 a launch is
// an ordered pair of calls (create the pane, then start the agent in it), so both are shown; the
// pane id is left as HERDR_PANE_PLACEHOLDER because it only exists once the first call has run.
export function herdrCommandLine(plan: HerdrLaunchPlan): string {
  return [plan.paneArgv, plan.argv]
    .map((argv) => argv.map(displayArg).join(" "))
    .join(" && ");
}

export interface HerdrLaunchInput {
  repo: string;
  workflow?: "issue-create" | "workflow-create" | "github-pr-export";
  prNumber?: number;
  codingAgent?: CodingAgent;
  model?: string;
  // One-shot reasoning effort for New issue launches (#1534). Maps to `lh issue new --effort`.
  effort?: string;
  targetBranch?: string;
  // Optional direct instructions for interactive creation flows.
  prompt?: string;
  env?: Record<string, string>;
}

// The runtime binary and its unescaped argv, for the launches that run a coding agent directly.
// herdr 0.7.5's `agent start --kind <kind> -- <args…>` execs the runtime's canonical binary with
// these args, so the prompt-carrying tokens never pass through a shell — which is what makes it
// safe for the multi-KB, newline-bearing contract prompts a workflow step launches with.
//
// Null for the issue-create workflow: its entrypoint is `lh issue new`, a LoopHub CLI that resolves
// config and registers the session before spawning the agent itself, so it is not a runtime binary
// `agent start --kind` could exec. That launch types its command into the pane instead
// (herdrPaneSendTextArgv) — it is a single short line, unlike a rendered contract.
export function agentProgramForHerdrLaunch(
  input: HerdrLaunchInput,
): { bin: RuntimeBin; args: string[]; prompt: string } | null {
  const wantsAgent =
    (input.workflow === "workflow-create" && input.prompt) ||
    (input.workflow === "github-pr-export" && input.prNumber && input.prompt);
  if (!wantsAgent || !input.prompt) return null;
  const agent = input.codingAgent ?? codingAgent();
  const runtimeInput = { runtime: agent, prompt: input.prompt };
  return {
    bin: RUNTIMES[agent].bin,
    args: buildRuntimeFlags(runtimeInput),
    prompt: runtimePrompt(runtimeInput),
  };
}

export function commandForHerdrLaunch(input: HerdrLaunchInput): string {
  const envPrefix = input.env
    ? Object.entries(input.env)
        .map(([key, value]) => `${key}=${shellArg(value)}`)
        .join(" ")
    : "";
  const withEnv = (command: string) =>
    envPrefix ? `${envPrefix} ${command}` : command;
  if (input.workflow === "issue-create") {
    // `lh issue new` is the recorded LoopHub entrypoint for the issue-create workflow.
    // When agent/model/effort are omitted, `lh issue new` resolves them from the repo's
    // effective Coding agent config (#1532/#1534) — same path as `lh workflow start`.
    const agentFlag = input.codingAgent
      ? ` ${RUNTIMES[input.codingAgent].buildFlag}`
      : "";
    const model = input.model?.trim();
    const modelFlag = model ? ` --model ${shellArg(model)}` : "";
    const effort = input.effort?.trim();
    const effortFlag = effort ? ` --effort ${shellArg(effort)}` : "";
    const targetBranchFlag = input.targetBranch
      ? ` --target-branch ${shellArg(input.targetBranch)}`
      : "";
    const promptFlag = input.prompt
      ? ` --prompt ${shellArg(input.prompt)}`
      : "";
    return withEnv(
      `lh issue new --repo ${shellArg(input.repo)}${targetBranchFlag}${agentFlag}${modelFlag}${effortFlag}${promptFlag}`,
    );
  }
  if (input.workflow === "workflow-create" && input.prompt) {
    // New workflow (Settings > Workflows): launch the coding agent interactively with the
    // workflow-create instructions as its initial prompt, mirroring the New issue flow's `--prompt`.
    // `lh workflow create` is global (no repo), so this runs from the LoopHub-home cwd the service
    // pins for it, not a repo worktree. The agent/model come from the global effective config
    // (`codingAgent()`).
    const agent = input.codingAgent ?? codingAgent();
    const argv = buildRuntimeArgs({ runtime: agent, prompt: input.prompt });
    return `${RUNTIMES[agent].bin} ${argv.map(shellArg).join(" ")}`;
  }
  if (input.workflow === "github-pr-export" && input.prNumber && input.prompt) {
    const agent = input.codingAgent ?? codingAgent();
    // The full filing instructions are injected directly as the agent's initial prompt (#1892),
    // the same prompt-injection approach as New issue, instead of dispatching the retired
    // /lh-create-github-pr skill.
    const argv = buildRuntimeArgs({
      runtime: agent,
      prompt: input.prompt,
    });
    return `${RUNTIMES[agent].bin} ${argv.map(shellArg).join(" ")}`;
  }
  return "";
}

// `--env KEY=VALUE`, repeated, in a stable order so the same launch always produces the same argv
// (the tests and the reproduce hint both compare argv verbatim). Since herdr 0.7.5 `agent start`
// execs the runtime binary directly and takes no environment of its own, so the agent's environment
// has to come from the pane it is started in — every pane-creating call below accepts these.
function herdrEnvArgs(env?: Record<string, string>): string[] {
  if (!env) return [];
  return Object.keys(env)
    .sort()
    .flatMap((key) => ["--env", `${key}=${env[key]}`]);
}

// Creates the tab whose pane the agent will be started in, so launches open a new tab instead of
// splitting the currently focused pane (#489). `cwd` defaults to the repo checkout; a worktree
// launch overrides it while the session name stays derived from the repo, so every launch for that
// repo — worktree-pinned or not — lands in the same herdr session (#584).
export function herdrTabCreateArgv(
  repo: TerminalLaunchRepo,
  cwd = repo.local_path,
  env?: Record<string, string>,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "tab",
    "create",
    "--cwd",
    cwd,
    ...herdrEnvArgs(env),
    "--no-focus",
  ];
}

// Splits an existing pane to make the pane a launch will start its agent in. Workflow child steps
// use this so Execute/Verify land beside their run's parent pane in the same tab; every other flow
// creates a fresh tab instead (#489).
export function herdrPaneSplitArgv(
  repo: TerminalLaunchRepo,
  paneId: string,
  direction: "right" | "down",
  cwd: string,
  env?: Record<string, string>,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "pane",
    "split",
    paneId,
    "--direction",
    direction,
    "--cwd",
    cwd,
    ...herdrEnvArgs(env),
  ];
}

// Writes the human-readable label onto the pane. Pre-0.7.5 herdr took this string as the `agent
// start` name and displayed it; 0.7.5 splits the two, so the label has to be set separately — and
// it must be, because it is the string LoopHub parses back (workflow agent names, the sidebar) out
// of `pane list`, not the slug in `agent start`.
export function herdrPaneRenameArgv(
  repo: TerminalLaunchRepo,
  paneId: string,
  label: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "pane",
    "rename",
    paneId,
    label,
  ];
}

// Types a shell command into a pane, for the one launch whose entrypoint is not a runtime binary
// (`lh issue new` — see agentProgramForHerdrLaunch). The trailing newline submits it.
export function herdrPaneSendTextArgv(
  repo: TerminalLaunchRepo,
  paneId: string,
  command: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "pane",
    "send-text",
    paneId,
    `${command}\n`,
  ];
}

// Opens (or reuses) a herdr *workspace* pinned to a git worktree's checkout path, so herdr's own
// workspace/worktree metadata reflects the PR's real worktree instead of a plain tab cd'd there
// by the launched command (#551). The path must already be a registered git worktree — herdr
// replies `worktree_not_found` otherwise, which callers treat like any other best-effort herdr
// failure (fall back to the plain tab-create launch).
//
// `--cwd repo.local_path` pins the *source* workspace of the open to the repo's parent checkout
// (#873). Without it herdr sources the open from whatever workspace is currently focused, and when
// that focus sits on *another* PR's linked-worktree workspace herdr refuses the open outright
// (`linked_worktree_source`: "New and open worktree actions start from the repo parent workspace").
// That refusal is exactly what used to drop the Build launch into the plain tab-create fallback,
// which then created its tab inside the focused (other PR's) workspace — the reported bug. Pinning
// the source to the repo root makes the open originate from the repo parent workspace regardless of
// focus, so the target worktree's own workspace is opened as intended.
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
    "--cwd",
    repo.local_path,
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
  env?: Record<string, string>,
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
    ...herdrEnvArgs(env),
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
export function herdrWorkspaceCreateArgv(
  repo: TerminalLaunchRepo,
  label?: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "workspace",
    "create",
    "--cwd",
    repo.local_path,
    ...(label ? ["--label", label] : []),
    "--no-focus",
  ];
}

export function herdrWorkspaceListArgv(repo: TerminalLaunchRepo): string[] {
  return ["herdr", "--session", herdrSessionName(repo), "workspace", "list"];
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
// (#625). A newly created New Issue workspace uses herdrWorkspaceFocusArgv, while a reused New
// Issue/worktree workspace's freshly added tab — and the plain repo-root tab fallback — are selected
// this way instead: their workspace already existed and isn't this launch's to (re)focus wholesale,
// so only the new tab is brought forward. Both were created with `--no-focus` so creation itself
// wouldn't yank focus mid-launch.
export function herdrTabFocusArgv(
  repo: TerminalLaunchRepo,
  tabId: string,
): string[] {
  return ["herdr", "--session", herdrSessionName(repo), "tab", "focus", tabId];
}

// Switches focus (workspace + tab + pane, in one call) to an already-running agent, by pane id.
// Unlike herdrWorkspaceFocusArgv above, this doesn't require the caller to know which workspace/tab
// the target lives in; the issue-list badge only knows the agent's pane id.
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

// `herdr agent start` reports the pane the new agent is running in. Herdr has used a couple of
// nearby shapes across commands, so accept the explicit agent/pane fields and validate exactly as
// other pane ids before persisting or focusing it. `root_pane` covers the pane-creating commands:
// `tab create` / `workspace create` / `worktree open` report their seeded pane there, while
// `pane split` reports the new pane as `pane` — one parser serves every step of a launch.
export function parseHerdrAgentPaneId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout);
    for (const candidate of [
      parsed?.result?.agent?.pane_id,
      parsed?.result?.pane?.pane_id,
      parsed?.result?.root_pane?.pane_id,
      parsed?.result?.pane_id,
    ]) {
      if (typeof candidate === "string" && HERDR_ID.test(candidate))
        return candidate;
    }
    return null;
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

// How long `agent start` waits for the runtime to become interactive before giving up. The launch
// is only reported successful once herdr has seen the agent's prompt, so this bounds the slowest
// acceptable cold start of `claude`/`codex`/`grok`. herdr's own default is 30s and its ceiling 300s.
const AGENT_START_TIMEOUT_MS = 120_000;

export function buildHerdrLaunchPlan(input: {
  repo: TerminalLaunchRepo;
  // The command as a person would read it. Also what actually runs for a `shell` launch; for an
  // `agent` launch it is display-only, since the argv below never passes through a shell.
  command: string;
  // The coding-agent binary, its (newline-free) flags, and the prompt to deliver once it is up —
  // from agentProgramForHerdrLaunch. When absent the launch types `command` into the pane instead.
  program?: { bin: RuntimeBin; args: string[]; prompt?: string } | null;
  // Environment for the pane the agent runs in. `agent start` has no environment of its own, so
  // anything the agent must see (LOOPHUB_SESSION_ID and friends) is set when the pane is created.
  env?: Record<string, string>;
  label?: string;
  // Pane to split to make this launch's pane. Workflow child steps split their run's parent pane so
  // Execute/Verify land in the same tab; every other flow creates a fresh tab instead.
  splitPaneId?: string | null;
  split?: "right" | "down";
  // Workspace the fresh tab is created in, keeping the launch inside the target worktree's own
  // workspace instead of wherever herdr's focus happens to be (#873). Ignored when splitting.
  workspaceId?: string | null;
  // Overrides repo.local_path as the agent's cwd (e.g. a PR worktree, #584 herdr worktree launch)
  // without changing the herdr session name, which stays derived from the repo so every launch
  // for it — worktree-pinned or not — lands in the same herdr session.
  cwd?: string;
}): HerdrLaunchPlan {
  const sessionName = herdrSessionName(input.repo);
  const label = normalizeAgentName(input.label || "LoopHub workflow");
  const cwd = input.cwd ?? input.repo.local_path;
  // Seeded with the placement rather than a real pane id: the pane does not exist yet, and the plan
  // has to be fully determined before it runs (it crosses the RPC boundary to `lh workflow
  // launch-step`). Placement is unique per launch in practice — a workflow child splits a pane it
  // reserved a sequence number for, and a fresh tab is created per launch — and any residual
  // collision surfaces as herdr's own `agent_name_taken`, not as a silently misattributed agent.
  const agentName = herdrAgentSlug(
    label,
    `${input.splitPaneId ?? ""} ${input.workspaceId ?? ""} ${cwd}`,
  );
  const paneArgv =
    input.splitPaneId && input.split
      ? herdrPaneSplitArgv(
          input.repo,
          input.splitPaneId,
          input.split,
          cwd,
          input.env,
        )
      : input.workspaceId
        ? herdrTabCreateInWorkspaceArgv(
            input.repo,
            input.workspaceId,
            cwd,
            input.env,
          )
        : herdrTabCreateArgv(input.repo, cwd, input.env);
  const argv = input.program
    ? [
        "herdr",
        "--session",
        sessionName,
        "agent",
        "start",
        agentName,
        "--kind",
        input.program.bin,
        "--pane",
        HERDR_PANE_PLACEHOLDER,
        "--timeout",
        String(AGENT_START_TIMEOUT_MS),
        "--",
        ...input.program.args,
      ]
    : herdrPaneSendTextArgv(input.repo, HERDR_PANE_PLACEHOLDER, input.command);
  // Only an `agent start` launch defers its prompt; a typed shell command already carries its own.
  const prompt = input.program?.prompt;
  const promptArgs = prompt
    ? herdrPromptPaneArgs(HERDR_PANE_PLACEHOLDER, prompt)
    : null;
  return {
    sessionName,
    agentName,
    label,
    command: input.command,
    cwd,
    paneArgv,
    renameArgv: herdrPaneRenameArgv(input.repo, HERDR_PANE_PLACEHOLDER, label),
    argv,
    promptArgv: promptArgs
      ? [
          ["herdr", "--session", sessionName, "pane", ...promptArgs.text],
          ["herdr", "--session", sessionName, "pane", ...promptArgs.submit],
        ]
      : [],
  };
}

// The step agent's launch, dispatched on the parent run's runtime (#516, #1521). The per-runtime
// shape — claude's --session-id / --append-system-prompt-file, codex/grok folding the rendered
// contract into a positional prompt, the sandbox-vs-approval posture — comes from the
// registry-driven runtime-args module.
//
// Flags and prompt are separate because herdr 0.7.5's `agent start` rejects any argument containing
// a newline. The flags are newline-free and go on the command line; the prompt — a rendered
// contract is multi-KB and full of newlines and quotes — is delivered into the agent's input
// afterwards, through the same bracketed-paste path LoopHub already uses for workflow instructions.
function buildWorkflowStepAgentProgram(
  input: {
    runtime: CodingAgent;
    sessionId: string;
    systemPromptPath: string;
    systemPrompt: string;
    userPrompt: string;
  },
  model: string | undefined,
): { bin: RuntimeBin; args: string[]; prompt: string } {
  const runtimeInput = {
    runtime: input.runtime,
    model,
    sessionId: input.sessionId,
    systemPromptFile: input.systemPromptPath,
    systemPrompt: input.systemPrompt,
    prompt: input.userPrompt,
  };
  return {
    bin: RUNTIMES[input.runtime].bin,
    args: buildRuntimeFlags(runtimeInput),
    prompt: runtimePrompt(runtimeInput),
  };
}

export function buildWorkflowStepHerdrLaunchPlan(input: {
  repo: TerminalLaunchRepo;
  runId: number;
  step: WorkflowStep;
  sequence: number;
  // Runtime the parent run resolved (#516). Claude Code launches `claude` with --session-id and
  // --append-system-prompt-file; Codex and Grok have neither, so they launch their own binary with
  // the rendered contract folded into the positional prompt and correlate only via the
  // LOOPHUB_SESSION_ID env.
  runtime: CodingAgent;
  sessionId: string;
  worktree: string;
  systemPromptPath: string;
  // The rendered contract text (same content written to systemPromptPath). Codex and Grok have no
  // --append-system-prompt-file equivalent, so the text is prepended to the positional prompt.
  systemPrompt: string;
  userPrompt: string;
  // The parent run's pane, split to place the child beside it in the same tab. Comes from the
  // parent agent's own HERDR_PANE_ID (see `lh workflow launch-step`); when absent the child falls
  // back to its own fresh tab, the same degraded placement the tab-less launch has always had.
  splitPaneId?: string | null;
  model?: string | null;
}): HerdrLaunchPlan {
  const env = {
    LOOPHUB_SESSION_ID: input.sessionId,
    LOOPHUB_WORKFLOW_REPO: input.repo.full_name,
    LOOPHUB_WORKFLOW_RUN: String(input.runId),
    LOOPHUB_WORKFLOW_STEP: input.step,
  };
  const model = input.model?.trim();
  const program = buildWorkflowStepAgentProgram(input, model);
  return buildHerdrLaunchPlan({
    repo: input.repo,
    command: [
      ...Object.entries(env).map(([key, value]) => `${key}=${shellArg(value)}`),
      program.bin,
      ...program.args.map(shellArg),
      shellArg(program.prompt),
    ].join(" "),
    program,
    env,
    label: workflowStepHerdrAgentName(input.runId, input.step, input.sequence),
    splitPaneId: input.splitPaneId,
    split: "down",
    cwd: input.worktree,
  });
}

// An injected herdr command runner. Both callers of the worktree-launch orchestration below spawn
// the `herdr` binary, but differently: lh-web runs it async (a synchronous spawn would stall the
// single server process serving every client), while CLI launchers (`lh workflow start --herdr`,
// etc.) run it in a short-lived process. Injecting the runner lets the orchestration itself stay
// spawn-agnostic and unit-testable with a scripted fake. Contract: never throw — a failed call
// resolves `ok:false` so the caller can fall back, mirroring the best-effort tolerance every
// direct herdr call in this codebase already has. `stdout` is the captured output when
// `captureStdout` was set (else ""), used to parse ids.
export type HerdrCmdRunner = (
  argv: string[],
  opts?: { captureStdout?: boolean },
) => Promise<{ stdout: string; ok: boolean }>;

// Substitutes the pane created by a plan's `paneArgv` step into the steps that follow it.
export function withHerdrPane(argv: string[], paneId: string): string[] {
  return argv.map((token) =>
    token === HERDR_PANE_PLACEHOLDER ? paneId : token,
  );
}

// herdr rejects `agent start` against a pane whose shell has not reached its prompt yet
// (`agent_pane_busy`: "agent target pane <id> is not an available shell"). A pane is not ready the
// instant `tab create` returns — measured at ~100ms on a warm session — so a launch that starts the
// agent immediately fails outright. This is a startup ordering race with a definite end, not a
// failure a human could act on, so it is waited out rather than surfaced: retry only this one error
// code, only within a short bound, and let every other failure through on the first attempt.
const AGENT_PANE_BUSY = "agent_pane_busy";
const PANE_READY_TIMEOUT_MS = 10_000;
const PANE_READY_POLL_MS = 100;

// A herdr invocation that reports enough to distinguish `agent_pane_busy` from a real failure.
export type HerdrLaunchRunner = (
  argv: string[],
) => Promise<{ stdout: string; stderr: string; ok: boolean }>;

export interface HerdrLaunchOutcome {
  ok: boolean;
  // The pane the launch created — set whenever the pane step succeeded, including when the agent
  // step then failed, so the caller can clean the pane up.
  paneId: string | null;
  // The tab the pane step created, when it created one (absent for a split placement).
  tabId: string | null;
  // Which step failed, for the caller's error message. Null on success. "prompt" means the agent
  // is up but never received its instructions — visibly different from a launch that never started.
  failed: "pane" | "agent" | "prompt" | null;
  stdout: string;
  stderr: string;
}

// Runs a launch plan's steps in order: create the pane, label it, start the work in it. Shared by
// every launcher (lh-web's terminal.launch, `lh workflow start --herdr`, `lh workflow launch-step`)
// so the pane-first sequence herdr 0.7.5 requires exists once.
//
// The rename is best-effort: the label is how LoopHub recognizes the pane later, but an agent that
// is already running must not be reported as a failed launch because its label did not stick.
export async function executeHerdrLaunchPlan(
  plan: HerdrLaunchPlan,
  run: HerdrLaunchRunner,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<HerdrLaunchOutcome> {
  const paneRes = await run(plan.paneArgv);
  const paneId = paneRes.ok ? parseHerdrAgentPaneId(paneRes.stdout) : null;
  if (!paneId) {
    return {
      ok: false,
      paneId: null,
      tabId: paneRes.ok ? parseHerdrTabId(paneRes.stdout) : null,
      failed: "pane",
      stdout: paneRes.stdout,
      stderr: paneRes.stderr,
    };
  }
  const tabId = parseHerdrTabId(paneRes.stdout);
  await run(withHerdrPane(plan.renameArgv, paneId));

  const deadline = PANE_READY_TIMEOUT_MS / PANE_READY_POLL_MS;
  let agentRes = await run(withHerdrPane(plan.argv, paneId));
  for (
    let attempt = 0;
    !agentRes.ok &&
    attempt < deadline &&
    agentRes.stderr.includes(AGENT_PANE_BUSY);
    attempt++
  ) {
    await sleep(PANE_READY_POLL_MS);
    agentRes = await run(withHerdrPane(plan.argv, paneId));
  }
  if (!agentRes.ok) {
    return {
      ok: false,
      paneId,
      tabId,
      failed: "agent",
      stdout: agentRes.stdout,
      stderr: agentRes.stderr,
    };
  }
  for (const argv of plan.promptArgv) {
    const promptRes = await run(withHerdrPane(argv, paneId));
    if (!promptRes.ok) {
      return {
        ok: false,
        paneId,
        tabId,
        failed: "prompt",
        stdout: promptRes.stdout,
        stderr: promptRes.stderr,
      };
    }
  }
  return {
    ok: true,
    paneId,
    tabId,
    failed: null,
    stdout: agentRes.stdout,
    stderr: agentRes.stderr,
  };
}

export interface HerdrWorktreeWorkspace {
  // The worktree's own workspace — where this launch creates its tab, so it lands in the worktree's
  // workspace instead of wherever herdr's focus happens to be (#873).
  workspaceId: string;
  // True when this acquisition opened the workspace for the first time (rather than reusing an
  // already-open one), so the caller owns it: it is the cleanup target on a failed launch, and the
  // one to bring forward on success.
  createdWorkspace: boolean;
  // The empty tab a first-time `worktree open` seeds the workspace with. The launch creates its own
  // tab (a seeded tab cannot carry the launch's `--env`, since `worktree open` takes no `--env`), so
  // this one is closed once the real tab exists. Null for a reused workspace, whose existing tabs
  // are not this launch's to touch.
  seedTabId: string | null;
}

// Opens (or reuses) the herdr workspace pinned to `worktreeCheckoutPath`, so a launch lands in the
// worktree's own workspace instead of splitting whatever pane is currently focused (#489, #551).
// Returns null when the `worktree open` fails outright (worktree_not_found, timeout, unparseable
// output) — the caller then falls back to a plain repo-root tab-create. Extracted from lh-web's
// terminal.launch so CLI herdr launchers reuse the same parsing-heavy dance (core/service.ts wraps
// its async herdr runner around this).
export async function acquireHerdrWorktreeWorkspace(
  repo: TerminalLaunchRepo,
  worktreeCheckoutPath: string,
  run: HerdrCmdRunner,
): Promise<HerdrWorktreeWorkspace | null> {
  const openRes = await run(herdrWorktreeOpenArgv(repo, worktreeCheckoutPath), {
    captureStdout: true,
  });
  if (!openRes.ok) return null;
  const opened = parseHerdrWorktreeOpenResult(openRes.stdout);
  if (!opened?.workspaceId) return null;
  return {
    workspaceId: opened.workspaceId,
    createdWorkspace: !opened.alreadyOpen,
    seedTabId: opened.alreadyOpen ? null : parseHerdrTabId(openRes.stdout),
  };
}
