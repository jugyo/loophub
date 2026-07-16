import { createHash } from "node:crypto";
import { autoModeOnBuild, type CodingAgent, codingAgent } from "../config.ts";
import { RUNTIMES } from "../runtimes.ts";
import {
  type ScheduledTaskInboxContext,
  scheduledTaskInboxEnv,
  scheduledTaskInboxPromptSuffix,
} from "../scheduled-task-inbox.ts";
import type { WorkflowStep } from "../workflow/compose.ts";
import { workflowStepHerdrAgentName } from "../workflow/herdr-agents.ts";
import { buildCodexSandboxArgs } from "./codex-launch.ts";

export interface TerminalLaunchRepo {
  full_name: string;
  local_path: string;
}

export interface HerdrLaunchPlan {
  sessionName: string;
  agentName: string;
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
// would run once its session existed (e.g. "lh build '...'"). That inner command doesn't depend on
// `herdr` at all, so it can't reproduce a herdr-specific failure.
export function herdrCommandLine(plan: HerdrLaunchPlan): string {
  return plan.argv.map(displayArg).join(" ");
}

export function commandForHerdrLaunch(input: {
  repo: string;
  // "issue-dev" (the Build button) has no entry here: worktree/PR provisioning and the herdr
  // launch itself are entirely `lh build --herdr`'s responsibility (#584) — the server only spawns
  // it directly (see launchIssueDevHerdr in service.ts) rather than building a command string for
  // an agent-start pane the way the other workflows below do.
  workflow?:
    | "issue-create"
    | "scheduled-task-create"
    | "resume"
    | "github-pr-export";
  prNumber?: number;
  session?: string;
  cwd?: string;
  codingAgent?: CodingAgent;
  model?: string;
  targetBranch?: string;
  env?: Record<string, string>;
}): string {
  const envPrefix = input.env
    ? Object.entries(input.env)
        .map(([key, value]) => `${key}=${shellArg(value)}`)
        .join(" ")
    : "";
  const withEnv = (command: string) =>
    envPrefix ? `${envPrefix} ${command}` : command;
  if (input.workflow === "issue-create") {
    // `lh issue new` is the recorded LoopHub entrypoint for the /lh-issue-create workflow.
    const agentFlag = input.codingAgent
      ? ` ${RUNTIMES[input.codingAgent].buildFlag}`
      : "";
    const model = input.model?.trim();
    const modelFlag = model ? ` --model ${shellArg(model)}` : "";
    const targetBranchFlag = input.targetBranch
      ? ` --target-branch ${shellArg(input.targetBranch)}`
      : "";
    return withEnv(
      `lh issue new --repo ${shellArg(input.repo)}${targetBranchFlag}${agentFlag}${modelFlag}`,
    );
  }
  if (input.workflow === "scheduled-task-create") {
    const command = shellArg("/lh-scheduled-task-create");
    const agent = input.codingAgent ?? codingAgent();
    if (agent === "codex") {
      const codexArgs = buildCodexSandboxArgs().map(shellArg).join(" ");
      return `codex ${codexArgs} ${command}`;
    }
    return `claude ${command}`;
  }
  if (input.workflow === "github-pr-export" && input.prNumber) {
    const command = shellArg(`/lh-create-github-pr ${input.prNumber}`);
    const agent = input.codingAgent ?? codingAgent();
    // Same auto-mode wiring as the Build button (lh build --auto / autoModeOnBuild,
    // cli/dev.ts's buildClaudeArgs / buildCodexArgs) so `git push` / `gh pr create` inside
    // /lh-create-github-pr don't hit permission prompts when auto mode is enabled for this agent.
    const auto = autoModeOnBuild(agent);
    if (agent === "codex") {
      const codexArgs = (
        auto
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : buildCodexSandboxArgs()
      )
        .map(shellArg)
        .join(" ");
      return `codex ${codexArgs} ${command}`;
    }
    const claudeArgs = auto
      ? `${shellArg("--permission-mode")} ${shellArg("auto")} `
      : "";
    return `claude ${claudeArgs}${command}`;
  }
  if (input.workflow === "resume" && input.session) {
    const resume = `claude --resume ${shellArg(input.session)}`;
    return input.cwd ? `cd ${shellArg(input.cwd)} && ${resume}` : resume;
  }
  return "";
}

// Builds the inner shell command a scheduled task (#880) runs in its herdr pane: the saved prompt
// handed to the agent's non-interactive mode. Claude uses `claude -p <prompt>` (print mode); Codex
// uses `codex exec <prompt>`. A scheduled fire is unattended, so both launch in a no-approval-prompt
// mode — there is no human to answer a mid-run prompt. Deliberately kept at the LIGHTER end: Codex
// runs inside its normal workspace-write sandbox (buildCodexSandboxArgs, the same posture the
// interactive Build button uses when auto mode is off) rather than the full
// `--dangerously-bypass-approvals-and-sandbox`, which is not needed for non-interactive execution and
// would be asymmetric with the claude branch's `--permission-mode auto` (mirroring buildClaudeArgs).
// `model` applies to both; `effort` is a Codex-only reasoning knob (claude has no effort flag),
// passed as its `model_reasoning_effort` config override. The prompt (and every interpolated value)
// is single-quote-escaped before it reaches `zsh -lc`, so a crafted prompt cannot inject a command.
export function buildScheduledTaskCommand(input: {
  agent: CodingAgent;
  prompt: string;
  model?: string | null;
  effort?: string | null;
  context?: ScheduledTaskInboxContext;
}): string {
  const promptText = input.context
    ? `${input.prompt.trimEnd()}${scheduledTaskInboxPromptSuffix(input.context)}`
    : input.prompt;
  const prompt = shellArg(promptText);
  const envPrefix = input.context
    ? `${Object.entries(scheduledTaskInboxEnv(input.context))
        .map(([key, value]) => `${key}=${shellArg(value)}`)
        .join(" ")} `
    : "";
  const model = input.model?.trim();
  if (input.agent === "codex") {
    const parts = ["codex", "exec", ...buildCodexSandboxArgs().map(shellArg)];
    if (model) parts.push("--model", shellArg(model));
    const effort = input.effort?.trim();
    if (effort) parts.push("-c", shellArg(`model_reasoning_effort=${effort}`));
    parts.push(prompt);
    return `${envPrefix}${parts.join(" ")}`;
  }
  const parts = ["claude", "-p", prompt, "--permission-mode", "auto"];
  if (model) parts.push("--model", shellArg(model));
  return `${envPrefix}${parts.join(" ")}`;
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

// Sends a key press to a pane (#832's cost-limit stop). Unlike herdrPaneCloseArgv this doesn't
// touch pane/tab state — it just injects a keystroke (e.g. `Escape`) into whatever the pane is
// running, which for an idle claude/codex TUI cancels the current turn without killing the agent
// (the issue's "auto で kill しない、Esc を送る程度に留める"). The `key` is a herdr key name, not
// arbitrary text; callers pass a fixed literal, never process output.
export function herdrPaneSendKeysArgv(
  repo: TerminalLaunchRepo,
  paneId: string,
  key: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "pane",
    "send-keys",
    paneId,
    key,
  ];
}

// Writes literal text to a pane without invoking a shell. Herdr's send-text contract treats the
// argument after paneId as the text positional, including when it starts with `-`; inserting `--`
// would instead send that marker as the text. The caller submits separately with
// herdrPaneSendKeysArgv(..., "Enter") so user input can never be parsed as a command by LoopHub.
export function herdrPaneSendTextArgv(
  repo: TerminalLaunchRepo,
  paneId: string,
  text: string,
): string[] {
  return [
    "herdr",
    "--session",
    herdrSessionName(repo),
    "pane",
    "send-text",
    paneId,
    text,
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
// other pane ids before persisting or focusing it.
export function parseHerdrAgentPaneId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout);
    for (const candidate of [
      parsed?.result?.agent?.pane_id,
      parsed?.result?.pane?.pane_id,
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

export function buildHerdrLaunchPlan(input: {
  repo: TerminalLaunchRepo;
  command: string;
  label?: string;
  // Tab to start the agent in (`--tab`). Preferred placement: it pins the agent to one exact tab.
  tabId?: string | null;
  // Workspace to start the agent in (`--workspace`) when no tab id is available — a weaker but still
  // safe placement that keeps the agent inside the target worktree's own workspace instead of
  // letting herdr fall back to splitting whatever pane is currently focused (which may belong to an
  // unrelated PR, #873). Ignored when tabId is set. When both are absent the launch omits any
  // placement selector and herdr splits the focused pane — the genuine last resort.
  workspaceId?: string | null;
  // Overrides repo.local_path as the agent's --cwd (e.g. a PR worktree, #584's `lh build --herdr`)
  // without changing the herdr session name, which stays derived from the repo so every launch
  // for it — worktree-pinned or not — lands in the same herdr session.
  cwd?: string;
  // Split an existing pane in the selected tab/workspace. Omitted for the tab-oriented launch
  // flows that create a fresh tab first; Workflow child steps deliberately split the parent run tab.
  split?: "right" | "down";
  // User-facing entry points can focus the new agent atomically with `agent start`. Workflow
  // children leave this false so their launch and later pane layout preserve the user's selection.
  focus?: boolean;
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
    ...(input.tabId
      ? ["--tab", input.tabId]
      : input.workspaceId
        ? ["--workspace", input.workspaceId]
        : []),
    ...(input.split ? ["--split", input.split] : []),
    input.focus ? "--focus" : "--no-focus",
    "--",
    "zsh",
    "-lc",
    input.command,
  ];
  return {
    sessionName,
    agentName,
    command: input.command,
    cwd,
    argv,
  };
}

export function buildWorkflowStepHerdrLaunchPlan(input: {
  repo: TerminalLaunchRepo;
  runId: number;
  step: WorkflowStep;
  sequence: number;
  // Runtime the parent run resolved (#516). Claude Code launches `claude` with --session-id and
  // --append-system-prompt-file; Codex has neither, so it launches `codex` with the rendered
  // contract folded into its positional prompt and correlates only via the LOOPHUB_SESSION_ID env.
  runtime: CodingAgent;
  sessionId: string;
  worktree: string;
  systemPromptPath: string;
  // The rendered contract text (same content written to systemPromptPath). Codex has no
  // --append-system-prompt-file equivalent, so the text is prepended to the positional prompt.
  systemPrompt: string;
  userPrompt: string;
  tabId?: string | null;
  model?: string | null;
  permissionMode?: "auto";
}): HerdrLaunchPlan {
  const env = [
    `LOOPHUB_SESSION_ID=${shellArg(input.sessionId)}`,
    `LOOPHUB_WORKFLOW_REPO=${shellArg(input.repo.full_name)}`,
    `LOOPHUB_WORKFLOW_RUN=${shellArg(String(input.runId))}`,
    `LOOPHUB_WORKFLOW_STEP=${shellArg(input.step)}`,
  ].join(" ");
  const model = input.model?.trim();
  const parts =
    input.runtime === "codex"
      ? [
          "codex",
          // Match the interactive Build button's Codex posture (cli/dev.ts buildCodexArgs): auto mode
          // bypasses approvals/sandbox, otherwise run inside the workspace-write sandbox.
          ...(input.permissionMode === "auto"
            ? ["--dangerously-bypass-approvals-and-sandbox"]
            : buildCodexSandboxArgs()
          ).map(shellArg),
          ...(model ? ["--model", shellArg(model)] : []),
          // Codex takes no system-prompt flag, so fold the rendered contract into the prompt.
          shellArg(`${input.systemPrompt}\n\n${input.userPrompt}`),
        ]
      : [
          "claude",
          "--session-id",
          shellArg(input.sessionId),
          ...(model ? ["--model", shellArg(model)] : []),
          ...(input.permissionMode
            ? ["--permission-mode", shellArg(input.permissionMode)]
            : []),
          "--append-system-prompt-file",
          shellArg(input.systemPromptPath),
          shellArg(input.userPrompt),
        ];
  return buildHerdrLaunchPlan({
    repo: input.repo,
    command: `${env} ${parts.join(" ")}`,
    label: workflowStepHerdrAgentName(input.runId, input.step, input.sequence),
    tabId: input.tabId,
    cwd: input.worktree,
    split: "down",
  });
}

// An injected herdr command runner. Both callers of the worktree-launch orchestration below spawn
// the `herdr` binary, but differently: lh-web runs it async (a synchronous spawn would stall the
// single server process serving every client), while `lh build --herdr` runs it in a short-lived CLI
// process. Injecting the runner lets the orchestration itself stay spawn-agnostic and unit-testable
// with a scripted fake. Contract: never throw — a failed call resolves `ok:false` so the caller can
// fall back, mirroring the best-effort tolerance every direct herdr call in this codebase already
// has. `stdout` is the captured output when `captureStdout` was set (else ""), used to parse ids.
export type HerdrCmdRunner = (
  argv: string[],
  opts?: { captureStdout?: boolean },
) => Promise<{ stdout: string; ok: boolean }>;

export interface HerdrWorktreeTab {
  tabId: string | null;
  rootPaneId: string | null;
  // Set only when this acquisition created a whole fresh single-tab workspace (a first-time
  // `worktree open`), whose sole tab herdr refuses to close via `tab close` — the caller closes the
  // workspace instead on failure. Null when an existing workspace was merely reused.
  workspaceId: string | null;
  // The worktree's own workspace id in *both* cases (fresh open or reuse) — the placement target
  // used for `agent start --workspace` when tabId came back null (#873), so the launch still lands
  // in this worktree's workspace instead of splitting an unrelated focused pane. Distinct from
  // workspaceId above, which is only the fresh-open workspace this launch *owns and must clean up*.
  targetWorkspaceId: string | null;
  createdWorkspace: boolean;
}

// Opens (or reuses) the herdr workspace pinned to `worktreeCheckoutPath` and returns a tab safe to
// pass to `agent start --tab`, so a launch lands in the worktree's own workspace instead of
// splitting whatever pane is currently focused (#489, #551). A first-time open creates a brand-new
// single-tab workspace whose tab/root-pane come straight from the open response; a reused workspace
// gets a genuinely new (safely closeable) tab created inside it, since its existing tab may already
// hold someone else's pane. Returns null when the initial `worktree open` fails outright
// (worktree_not_found, timeout, unparseable output) — the caller then falls back to a plain
// repo-root tab-create. Extracted from lh-web's terminal.launch so `lh build --herdr` reuses the same
// parsing-heavy dance (core/service.ts wraps its async herdr runner around this).
export async function acquireHerdrWorktreeTab(
  repo: TerminalLaunchRepo,
  worktreeCheckoutPath: string,
  run: HerdrCmdRunner,
): Promise<HerdrWorktreeTab | null> {
  const openRes = await run(herdrWorktreeOpenArgv(repo, worktreeCheckoutPath), {
    captureStdout: true,
  });
  if (!openRes.ok) return null;
  const opened = parseHerdrWorktreeOpenResult(openRes.stdout);
  if (!opened) return null;
  if (!opened.alreadyOpen) {
    return {
      tabId: parseHerdrTabId(openRes.stdout),
      rootPaneId: parseHerdrRootPaneId(openRes.stdout),
      workspaceId: opened.workspaceId,
      targetWorkspaceId: opened.workspaceId,
      createdWorkspace: true,
    };
  }
  if (!opened.workspaceId) return null;
  const tabRes = await run(
    herdrTabCreateInWorkspaceArgv(
      repo,
      opened.workspaceId,
      worktreeCheckoutPath,
    ),
    { captureStdout: true },
  );
  if (!tabRes.ok) return null;
  return {
    tabId: parseHerdrTabId(tabRes.stdout),
    rootPaneId: parseHerdrRootPaneId(tabRes.stdout),
    // The reused workspace predates this call, so it is not ours to close on failure — only the
    // freshly added tab (if its id parsed) is.
    workspaceId: null,
    // …but it is still the correct placement target: a launch whose new tab's id failed to parse
    // can fall back to `agent start --workspace <this>` and stay in the worktree's workspace (#873).
    targetWorkspaceId: opened.workspaceId,
    createdWorkspace: false,
  };
}
