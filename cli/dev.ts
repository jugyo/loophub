import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { git } from "../core/git.ts";
import { isClaudeSessionId } from "../core/resume.ts";
import { CODING_AGENTS, type CodingAgent, RUNTIMES } from "../core/runtimes.ts";
import { buildCodexSandboxArgs } from "../core/terminal/codex-launch.ts";
import {
  legacyWorktreeBranch,
  legacyWorktreePath,
  worktreeBranch,
  worktreePath,
} from "../core/worktree-path.ts";
import {
  type ProvisionInput,
  provisionWorktree,
  shouldCreateMissingConventionBranch,
} from "../core/worktree-provision.ts";

// `provisionWorktree` (git-worktree-add orchestration) moved to core/worktree-provision.ts so
// `core/service.ts` can call it too (terminal.launch's herdr worktree-open flow); re-exported here
// so existing cli/dev.ts callers and tests keep importing it from this module.
export {
  type ProvisionInput,
  provisionWorktree,
  shouldCreateMissingConventionBranch,
};

// `lh build` provisions an isolated git worktree (outside the sandbox) and launches an
// interactive Claude session in it. Everything here is pure CLI-side policy — it imports
// git plumbing from core but no DB — so it can be unit-tested and later moved to a
// swappable same-repo runner without touching core.

// ---- sandbox managed-settings ----
//
// Domains from --repo/--allow are validated and JSON-serialized here (never
// string-concatenated) so a value can never inject a sandbox key.
export const SANDBOX_DEFAULT_ALLOWED_DOMAINS = [
  "api.anthropic.com",
  "github.com",
];

// A DNS label plus an optional single leading `*.` wildcard. No bare `*`, no quotes/spaces.
const DEV_DOMAIN_RE =
  /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function validateDomain(raw: string): string {
  const d = raw.trim().toLowerCase();
  if (!d || d.length > 253 || !DEV_DOMAIN_RE.test(d)) {
    throw new Error(
      `invalid --allow domain "${raw}" (expected hostname or *.hostname)`,
    );
  }
  return d;
}

export function validateRepo(repo: string): void {
  if (repo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`invalid --repo "${repo}" (expected owner/name)`);
  }
}

export async function validateExistingLocalBranch(
  repoPath: string,
  branch: string,
  label = "branch",
): Promise<void> {
  if (branch.startsWith("-") || /[\0\r\n]/.test(branch)) {
    throw new Error(`${label} must be a local branch name`);
  }
  const result = await git(repoPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (result.code !== 0) {
    throw new Error(`${label} must name an existing local branch: ${branch}`);
  }
}

// Parse + validate the comma-separated `--allow` list and union it with the defaults.
// Exported so the CLI can validate up front (fail fast before provisioning a worktree).
export function resolveAllowedDomains(allow?: string): string[] {
  const extra = (allow ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(validateDomain);
  return [...new Set([...SANDBOX_DEFAULT_ALLOWED_DOMAINS, ...extra])];
}

// The git paths a `git add` / `git commit` from inside a linked worktree must be able to
// write. A worktree's `.git` is a pointer file; the real targets live in the *shared*
// common dir (objects/refs/logs) and the per-worktree gitdir — both outside the sandbox's
// default cwd write-allow. We grant exactly these, scoping refs to the issue branch, so the
// sandboxed agent can commit its own branch but cannot rewrite other refs (e.g. `main`),
// touch sibling worktrees, or reach `hooks`/`config` (all simply absent from the allow-list).
export interface WorktreeGitPaths {
  gitDir: string; // shared common dir (e.g. <repo>/.git) — core/git.ts gitCommonDir()
  worktreeGitDir: string; // this worktree's dir (<gitDir>/worktrees/<id>) — gitDirOf()
  branch: string | null; // checked-out branch; null when detached (no shared ref to write)
}

function gitWriteAllowList({
  gitDir,
  worktreeGitDir,
  branch,
}: WorktreeGitPaths): string[] {
  const allow = [
    join(gitDir, "objects"), // new loose objects (and their tmp_obj_* / fan-out dirs)
    worktreeGitDir, // index(.lock), HEAD, ORIG_HEAD, COMMIT_EDITMSG, logs/HEAD
  ];
  if (branch) {
    const ref = join(gitDir, "refs", "heads", branch);
    allow.push(ref, `${ref}.lock`); // loose ref update writes <ref>.lock then renames
    allow.push(join(gitDir, "logs", "refs", "heads", branch)); // branch reflog (appended)
  }
  return allow;
}

export function buildManagedSettings({
  repo,
  allow,
  git,
}: {
  repo: string;
  allow?: string;
  // When provided, grant the sandbox write access to exactly the git paths a worktree commit
  // needs (see gitWriteAllowList). Omitted in non-worktree contexts (and in pure unit tests).
  git?: WorktreeGitPaths;
}): {
  json: string;
  allowedDomains: string[];
} {
  validateRepo(repo);
  const allowedDomains = resolveAllowedDomains(allow);

  const filesystem: {
    denyRead: string[];
    allowWrite?: string[];
  } = {
    denyRead: [
      "~/.ssh",
      "~/.aws",
      "~/.gnupg",
      "~/.netrc",
      "~/.config/gh",
      "~/.kube",
      "~/.docker/config.json",
    ],
  };
  if (git) {
    filesystem.allowWrite = gitWriteAllowList(git);
    // `hooks`/`config`/`packed-refs`/other refs/other worktrees are not in the allow-list,
    // so they are already unwritable. The per-worktree gitdir's `config.worktree` is writable,
    // but only recognized by git when `extensions.worktreeConfig` is explicitly enabled in
    // the shared config (which is denied), so this is not a practical risk in default setups.
  }

  const json = JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ["gh *"],
      filesystem,
      network: { allowedDomains, allowManagedDomainsOnly: true },
    },
    permissions: { defaultMode: "auto" },
  });
  return { json, allowedDomains };
}

// ---- interactive launch args ----
//
// Build the `claude` argv for the interactive dev session. Auto mode (`--permission-mode auto`)
// is enabled when either the sandbox managed-settings are present (`--sandbox`, the historical
// coupling) or the caller explicitly passes `--auto`. `--auto` alone deliberately relaxes the old
// safety premise — it enables auto-run *without* the sandbox guard rails — so it takes effect only
// when the user opts in explicitly (never by default). Without `--auto` and without the sandbox,
// the session starts in Claude's normal approval mode.
// `auto` (vs `acceptEdits`) lets the session run Bash/network/edits without prompting — driven
// by Claude's safety classifier, which still stops to confirm genuinely destructive actions
// (force push, `terraform destroy`, `curl | bash`, …) — so a sandboxed dev loop is not blocked
// on routine approvals. The OS sandbox enforces the filesystem/network boundary independently.
// The settings JSON is handed to `claude` via `--settings <json>` (the flag that loads an inline
// settings object — `sandbox` block + `permissions.defaultMode`); a CLI `--permission-mode auto`
// (higher precedence than a settings file) is also passed so the live interactive mode is driven
// explicitly regardless of how `defaultMode` is merged. `--settings` is the command-line tier
// (above project/local/user settings) but NOT the managed/policy tier, so `sandbox.enabled` /
// `failIfUnavailable` / `defaultMode` take effect while managed-only lockdown keys (e.g.
// `allowManagedDomainsOnly`) are best-effort here. (Historically this used `--managed-settings`,
// which is not a real `claude` flag — `claude` silently dropped the whole JSON, so neither the
// sandbox nor auto mode ever took effect.) Centralized here so the displayed spawn command line
// (formatSpawnCommand) and the real spawn share one source of truth.
// Parse the `lh build` positional target. Two accepted forms:
//   <id>                  e.g. "116"            → { id: 116 }            (repo from cwd/--repo)
//   <owner>/<repo>/<id>   e.g. "jugyo/lh/116"   → { repo: "jugyo/lh", id: 116 }
// The owner/repo/id form lets `lh build` start from outside the target repo's working directory
// without `--repo`; the bare-id form is the shorthand that defers repo resolution to the caller
// (resolveRepo: cwd match or --repo). A malformed target (non-numeric id, wrong segment count,
// or an empty owner/repo segment) throws a usage error. Pure so it can be unit-tested.
export function parseDevTarget(target: string): { repo?: string; id: number } {
  const parts = target.split("/");
  if (parts.length === 1) {
    if (!/^[0-9]+$/.test(parts[0])) {
      throw new Error(
        `invalid issue id ${JSON.stringify(target)} (expected a number)`,
      );
    }
    return { id: Number(parts[0]) };
  }
  if (parts.length === 3) {
    const [owner, name, id] = parts;
    if (!owner || !name || !/^[0-9]+$/.test(id)) {
      throw new Error(
        `invalid target ${JSON.stringify(target)} (expected <owner>/<repo>/<id>)`,
      );
    }
    return { repo: `${owner}/${name}`, id: Number(id) };
  }
  throw new Error(
    `invalid target ${JSON.stringify(target)} (expected <id> or <owner>/<repo>/<id>)`,
  );
}

// ---- runtime selection ----
//
// `lh build` can launch the interactive dev session in Claude Code (default), Codex (#458), or
// Grok Build. The worktree/PR/session preparation is runtime-independent; only the final spawn
// differs. DevRuntime is the CLI-side alias of the core runtime id (core/runtimes.ts CodingAgent) —
// the two are the same set of values, kept as one type here so the union isn't declared twice.
export type DevRuntime = CodingAgent;

// Resolve the runtime from the mutually-exclusive `--claude-code` / `--codex` / `--grok` flags.
// Passing more than one is ambiguous — fail loudly rather than pick one. When no flag is passed,
// `defaultRuntime` (the `codingAgent` app setting, #516) decides; omitting it too falls back to the
// historical default (Claude Code), so plain `lh build <id>` behavior is unchanged for callers that
// don't pass it (e.g. existing tests). The flag names are read from the registry so a new runtime
// only needs its entry, not another branch here.
export function resolveDevRuntime(flags: {
  claudeCode?: boolean;
  codex?: boolean;
  grok?: boolean;
  defaultRuntime?: DevRuntime;
}): DevRuntime {
  const passed: Record<CodingAgent, boolean | undefined> = {
    "claude-code": flags.claudeCode,
    codex: flags.codex,
    grok: flags.grok,
  };
  const selected = CODING_AGENTS.filter((id) => passed[id]);
  if (selected.length > 1) {
    throw new Error(
      `${selected.map((id) => RUNTIMES[id].buildFlag).join(", ")} are mutually exclusive (pass at most one)`,
    );
  }
  return selected[0] ?? flags.defaultRuntime ?? "claude-code";
}

// Build the `codex` argv for the interactive dev session. Codex takes the initial prompt as a
// positional (`codex [PROMPT]`), so the same `/lh-build <id>` slash command Claude receives is
// handed to Codex verbatim — the rest of the context (worktree cwd, registered session, linked
// PR) is prepared before spawn and is runtime-independent. Codex has no `--session-id` /
// `--name` / `--settings` equivalents. Sandboxed launches receive a Codex config override that
// grants LOOPHUB_HOME as a writable root; claude-only flags (--sandbox/--allow) are rejected up
// front by the CLI, not silently dropped here.
export function buildCodexArgs({
  slashCommand,
  auto,
  model,
  loopHubHome,
}: {
  slashCommand: string;
  // Opt into Codex's auto-mode equivalent (#499): skip approval prompts and run unsandboxed,
  // matching Claude Code's --auto (`--permission-mode auto`, "no guard rails" — see
  // buildClaudeArgs). Codex's closest single flag for that is
  // --dangerously-bypass-approvals-and-sandbox.
  auto?: boolean;
  // Model for the session (`-m/--model <name>`, #594). No name validation — an unknown name is
  // the codex CLI's error to raise. Omitted => codex's own default. Control characters are
  // stripped (see display()), same invariant as buildClaudeArgs' model.
  model?: string;
  // Effective LOOPHUB_HOME to grant as a Codex sandbox writable root. Defaults to the same
  // configDir() resolution used by LoopHub DB/config writes.
  loopHubHome?: string;
}): string[] {
  const args: string[] = [];
  if (auto) args.push("--dangerously-bypass-approvals-and-sandbox");
  else args.push(...buildCodexSandboxArgs(loopHubHome));
  if (model) {
    const m = display(model).trim();
    if (m) args.push("--model", m);
  }
  args.push(slashCommand);
  return args;
}

// Build the `grok` argv for the interactive dev session. Mirrors buildCodexArgs: grok takes the
// initial prompt as a positional, so the same `/lh-build <id>` slash command the other runtimes
// receive is handed to grok verbatim — the rest of the context (worktree cwd, registered session,
// linked PR) is prepared before spawn and is runtime-independent. grok has no sandbox concept
// (claude-only --sandbox/--allow are rejected up front by the CLI, same as codex) and no
// --session-id / --name / --settings equivalent.
//
// NOTE: the grok headless launch flags are TENTATIVE — no running `grok` CLI was available to verify
// against at implementation time. The positional prompt + `--model` + auto-bypass shape follows the
// codex pattern and must be re-verified against the official `grok` CLI before relying on it.
export function buildGrokArgs({
  slashCommand,
  auto,
  model,
}: {
  slashCommand: string;
  // Opt into grok's auto-mode equivalent: skip approval prompts and auto-run tools, matching Claude
  // Code's --auto (`--permission-mode auto`) and Codex's --dangerously-bypass-approvals-and-sandbox.
  // `--force` is grok's closest single flag for that (TENTATIVE — see the NOTE above).
  auto?: boolean;
  // Model for the session (`--model <name>`). No name validation — an unknown name is the grok CLI's
  // error to raise. Omitted => grok's own default. Control characters are stripped (see display()),
  // same invariant as buildCodexArgs' model.
  model?: string;
}): string[] {
  const args: string[] = [];
  if (auto) args.push("--force");
  if (model) {
    const m = display(model).trim();
    if (m) args.push("--model", m);
  }
  args.push(slashCommand);
  return args;
}

export function buildClaudeArgs({
  sessionId,
  managedSettings,
  auto,
  slashCommand,
  sessionName,
  model,
}: {
  sessionId: string;
  managedSettings?: string;
  // Opt into auto mode (`--permission-mode auto`) without the sandbox. `--sandbox` already
  // implies auto via managedSettings; `--auto` enables it independently (no guard rails).
  auto?: boolean;
  slashCommand: string;
  // Display name for the session picker / terminal title (e.g. `#54 <issue title>`). Stripped
  // of control characters before it reaches argv (see display()) so a crafted issue title can
  // never inject escape sequences into the spawned terminal.
  sessionName?: string;
  // Model for the session (`--model <name>`, #486). No name validation — an unknown name is
  // the claude CLI's error to raise. Omitted => claude's default. Control characters are
  // stripped (see display()) like every other argv value that reaches terminal output
  // (the echoed spawn line), same invariant as sessionName.
  model?: string;
}): string[] {
  const args = ["--session-id", sessionId];
  if (model) {
    const m = display(model).trim();
    if (m) args.push("--model", m);
  }
  if (auto || managedSettings) {
    // Auto mode when explicitly requested (--auto) or implied by the sandbox (managedSettings).
    args.push("--permission-mode", "auto");
  }
  if (sessionName) {
    const name = display(sessionName).trim();
    if (name) args.push("--name", name);
  }
  if (managedSettings) {
    // `--settings` (file-or-json) is the flag that loads an inline settings object; the
    // long-gone `--managed-settings` was silently ignored, dropping the whole JSON.
    args.push("--settings", managedSettings);
  }
  args.push(slashCommand);
  return args;
}

// Per-runtime argv builders, keyed by runtime id. The builders themselves stay in this (node-dependent)
// module — core/runtimes.ts is node-free — so the registry drives the dispatch by id and supplies the
// `bin`, while the functions live here. Adding a runtime means adding one entry here plus its registry
// definition, not another branch in buildRuntimeLaunch.
type RuntimeArgvInput = {
  sessionId: string;
  managedSettings?: string;
  auto?: boolean;
  slashCommand: string;
  sessionName?: string;
  model?: string;
};

const RUNTIME_ARGV_BUILDERS: Record<
  DevRuntime,
  (input: RuntimeArgvInput) => string[]
> = {
  "claude-code": ({
    sessionId,
    managedSettings,
    auto,
    slashCommand,
    sessionName,
    model,
  }) =>
    buildClaudeArgs({
      sessionId,
      managedSettings,
      auto,
      slashCommand,
      sessionName,
      model,
    }),
  codex: ({ slashCommand, auto, model }) =>
    buildCodexArgs({ slashCommand, auto, model }),
  grok: ({ slashCommand, auto, model }) =>
    buildGrokArgs({ slashCommand, auto, model }),
};

export function buildRuntimeLaunch({
  runtime,
  sessionId,
  managedSettings,
  auto,
  slashCommand,
  sessionName,
  model,
}: RuntimeArgvInput & {
  runtime: DevRuntime;
}): { bin: "claude" | "codex" | "grok"; args: string[] } {
  return {
    bin: RUNTIMES[runtime].bin,
    args: RUNTIME_ARGV_BUILDERS[runtime]({
      sessionId,
      managedSettings,
      auto,
      slashCommand,
      sessionName,
      model,
    }),
  };
}

// `lh resume <PR id>` re-enters an existing Claude session rather than starting a new one, so the
// argv is just `claude --resume <session-id>` (no --session-id / slash command / sandbox settings —
// the original session already carries its history and the worktree is reused). Pure so it can be
// unit-tested and shares the displayed-vs-spawned single source of truth (formatSpawnCommand).
// Asserts the id is UUID-shaped (service.resume.resolve already gates this) so a malformed/flag-like
// value can never reach `claude --resume` as a spoofed flag — see isClaudeSessionId.
export function buildResumeArgs({
  sessionId,
}: {
  sessionId: string;
}): string[] {
  if (!isClaudeSessionId(sessionId)) {
    throw new Error(
      `invalid session id for resume: ${JSON.stringify(sessionId)}`,
    );
  }
  return ["--resume", sessionId];
}

// ---- launch plan (pure, human-readable) ----
//
// Render the settings about to be handed to `claude` so a human can confirm before spawn.
// Pure (string in, string out) so it can be unit-tested and so the formatting never depends
// on a TTY. The managed settings are parsed from the same JSON that is passed on the wire,
// guaranteeing what is shown is exactly what is sent (no second source of truth).
export interface LaunchPlan {
  repo: string;
  worktree: string;
  sessionId: string;
  slashCommand: string;
  managedSettings: string; // the JSON from buildManagedSettings
  claudeArgs: string[]; // the argv from buildClaudeArgs
}

// Strip ANSI/terminal control sequences from any value rendered into the plan. The plan is
// a safety artifact a human reads before launch; a value sourced from a repo's full_name
// (not validated at registration) must not be able to forge or hide the displayed settings.
function display(v: string): string {
  // Remove ANSI/VT escape sequences first, then any remaining C0/C1 control bytes (CR, BEL,
  // backspace, …) — a bare \r or \b can still overwrite the rendered line on its own. The range
  // covers DEL (0x7f) and the 8-bit C1 controls (0x80-0x9f), so a single C1 OSC/CSI introducer
  // (e.g. 0x9d) in an attacker-controlled title can't reach a terminal title (claude --name).
  return stripVTControlCharacters(v).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

// Like display(), but for multi-line values (e.g. an issue body) where newlines carry meaning.
// Sanitizes each line independently and rejoins with "\n", so genuine line breaks survive while
// every other control byte (CR, BEL, backspace, …) and ANSI/VT sequence is still stripped.
export function displayMultiline(v: string): string {
  return v.split("\n").map(display).join("\n");
}

export function formatLaunchPlan(plan: LaunchPlan): string {
  const s = JSON.parse(plan.managedSettings) as any;
  const sandbox = s.sandbox ?? {};
  const network = sandbox.network ?? {};
  const filesystem = sandbox.filesystem ?? {};
  const denyRead: string[] = (filesystem.denyRead ?? []).map(display);
  const excluded: string[] = (sandbox.excludedCommands ?? []).map(display);
  const domains: string[] = (network.allowedDomains ?? []).map(display);

  const permIdx = plan.claudeArgs.indexOf("--permission-mode");
  const permVal =
    permIdx >= 0 && permIdx + 1 < plan.claudeArgs.length
      ? plan.claudeArgs[permIdx + 1]
      : undefined;
  const permissionMode = permVal != null ? display(permVal) : "(default)";

  const nameIdx = plan.claudeArgs.indexOf("--name");
  const nameVal =
    nameIdx >= 0 && nameIdx + 1 < plan.claudeArgs.length
      ? plan.claudeArgs[nameIdx + 1]
      : undefined;

  const lines = [
    "Review the settings to be passed to `claude` before launch:",
    "",
    "  Context",
    `    repo:        ${display(plan.repo)}`,
    `    worktree:    ${display(plan.worktree)}`,
    `    session-id:  ${display(plan.sessionId)}`,
    `    command:     ${display(plan.slashCommand)}`,
    "",
    "  Managed settings (sandbox)",
    `    sandbox:            ${sandbox.enabled ? "enabled" : "disabled"}${sandbox.failIfUnavailable ? " (fail if unavailable)" : ""}`,
    `    unsandboxed cmds:   ${sandbox.allowUnsandboxedCommands ? "allowed" : "denied"}`,
    `    excluded cmds:      ${excluded.length ? excluded.join(", ") : "(none)"}`,
    `    network domains:    ${domains.length ? domains.join(", ") : "(none)"}${network.allowManagedDomainsOnly ? " (managed only)" : ""}`,
    `    permissions mode:   ${display(String(s.permissions?.defaultMode ?? "(default)"))}`,
    `    filesystem denyRead:${denyRead.length ? "" : " (none)"}`,
    ...denyRead.map((p) => `      - ${p}`),
    "",
    "  Command-line settings",
    `    --permission-mode:  ${permissionMode}`,
    ...(nameVal != null ? [`    --name:             ${display(nameVal)}`] : []),
  ];
  return lines.join("\n");
}

// The default (non-verbose) launch output: just the basic context a human needs to see what is
// being worked on and where. The full managed-settings / launch-plan block (formatLaunchPlan) is
// reserved for `--verbose` — by default the issue body and sandbox details are suppressed (#383).
// Pure (string in, string out); values are control-char stripped (see display()) so a crafted
// repo/branch can't forge the displayed lines.
export function formatLaunchSummary({
  repo,
  worktree,
  branch,
  sessionId,
}: {
  repo: string;
  worktree: string;
  branch: string;
  sessionId: string;
}): string {
  return [
    `  repo:        ${display(repo)}`,
    `  worktree:    ${display(worktree)}`,
    `  branch:      ${display(branch)}`,
    `  session-id:  ${display(sessionId)}`,
  ].join("\n");
}

// Single-quote a value for a shell command string so it survives copy-paste / re-exec verbatim.
// Used by the launch command line shown to the human; even where inputs are validated upstream,
// quote defensively so the pure builders are safe on any input.
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ANSI "dim/faint" wrapper — renders as gray on most terminals. Callers gate `color` on a TTY
// so non-interactive output (pipes, logs, redirected stderr) stays plain, copyable text.
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// Render the exact runtime command line that will be spawned. Built from the same argv passed
// to spawnSync, so what the human reads is byte-for-byte what runs (single source of truth).
// `bin` selects the runtime binary (`claude` by default, `codex` for --codex, #458). With
// `color`, the line is wrapped in ANSI dim for an always-on gray display.
export function formatSpawnCommand(
  runtimeArgs: string[],
  opts: { color?: boolean; bin?: string } = {},
): string {
  const line = `${opts.bin ?? "claude"} ${runtimeArgs.map(shQuote).join(" ")}`;
  return opts.color ? `${DIM}${line}${RESET}` : line;
}

// ---- worktree provisioning ----
//
// Path and branch are deterministic from the PR number (no slug, #463). Reuse is derived from
// disk truth (`git worktree list` + naming convention) — there is no ledger table. The pure
// path/branch helpers live in core/worktree-path.ts (shared with core/service.ts for
// `lh resume`); re-exported here so existing cli/dev.ts callers and tests keep importing them.
export {
  legacyWorktreeBranch,
  legacyWorktreePath,
  worktreeBranch,
  worktreePath,
};

// ---- dev lock (single-host duplicate-launch guard) ----
//
// A `lh build` worktree is deterministic per PR (#463 — previously per issue), so a second
// `lh build` targeting the same PR reuses the *same* worktree — two live sessions editing one tree
// clobber each other. We guard this with a lock file keyed by (repo, PR) under LOOPHUB_HOME
// recording the running `lh build` process: `lh build` launches `claude` via a blocking `spawnSync`,
// so the `lh` process is alive for exactly the session's lifetime, making its PID a precise
// liveness signal. A new launch that finds a lock whose PID is still alive refuses (unless
// --force); one whose PID is gone (crash / Ctrl-C) treats it as stale and reclaims it — so a
// finished/interrupted session never blocks a relaunch. Keying by PR (not issue) means two PRs
// linked to the same issue can now run `lh build` concurrently without colliding; a second
// concurrent `lh build <issue>` racing to open the *first* PR for that issue is not separately
// guarded — out of scope for #463. The lock is host-local by design (cross-host exclusion is out
// of scope) and lives outside the worktree, so it never leaks into a PR. Pure decision logic is
// split from the fs/PID side effects so it can be unit-tested.
export interface DevLock {
  pid: number;
  pr: number;
  worktree: string;
  sessionId: string;
  startedAt: string; // ISO8601
}

// Deterministic lock path: <home>/dev-locks/<owner>/<repo>/pr-<n>.json. Guards every
// fullName segment like worktreePath so a crafted repo name can't traverse out of <home>.
export function devLockPath(
  home: string,
  fullName: string,
  pr: number,
): string {
  for (const seg of fullName.split("/")) {
    if (!seg || seg === "." || seg === ".." || seg.includes("\\")) {
      throw new Error(`invalid repo name for dev-lock path: "${fullName}"`);
    }
  }
  return join(home, "dev-locks", fullName, `pr-${pr}.json`);
}

// Is a process alive? `kill(pid, 0)` sends no signal but throws ESRCH when the pid is gone;
// EPERM means it exists but is owned by another user (still alive). Injected into acquireDevLock
// so the branch logic stays testable.
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export type AcquireDevLock =
  | { ok: true } // claimed: created fresh, reclaimed a stale/malformed lock, or forced
  | { ok: false; held: DevLock }; // a live holder owns it — caller blocks unless --force

// Atomically claim the lock for this launch. An exclusive create (`wx`) collapses the check and
// the write into one filesystem operation, so two near-simultaneous launches cannot both observe
// "free" and both win. If the file already exists, re-read it: a live holder (and not --force)
// blocks; a stale (dead pid), malformed, or forced holder is reclaimed by overwriting. The tiny
// window between the EEXIST re-read and the reclaim is acceptable for a host-local, single-user
// advisory guard (cross-host exclusion is out of scope). The liveness predicate is injected so
// the branch logic stays testable.
export function acquireDevLock(
  path: string,
  lock: DevLock,
  isAlive: (pid: number) => boolean,
  opts: { force?: boolean } = {},
): AcquireDevLock {
  mkdirSync(dirname(path), { recursive: true });
  const data = `${JSON.stringify(lock, null, 2)}\n`;
  try {
    writeFileSync(path, data, { flag: "wx" }); // exclusive create: EEXIST if already present
    return { ok: true };
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
  }
  const existing = readDevLock(path);
  if (!opts.force && existing && isAlive(existing.pid)) {
    return { ok: false, held: existing };
  }
  writeFileSync(path, data); // reclaim a stale / malformed lock (or forced override)
  return { ok: true };
}

// Read + parse the lock file. Missing / unreadable / malformed all collapse to null (no lock),
// so a corrupt or partial lock never wedges `lh build` — it's treated as free and reclaimed. The
// full shape is validated (not just `pid`), so a truncated `{"pid":N}` doesn't slip through and
// surface as `undefined` fields in the block message.
export function readDevLock(path: string): DevLock | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    if (
      v &&
      Number.isInteger(v.pid) &&
      typeof v.pr === "number" &&
      typeof v.worktree === "string" &&
      typeof v.sessionId === "string" &&
      typeof v.startedAt === "string"
    ) {
      return v as DevLock;
    }
    return null;
  } catch {
    return null;
  }
}

export function removeDevLock(path: string): void {
  try {
    rmSync(path);
  } catch {
    // Already gone (never written, or reclaimed by another launch) — nothing to do.
  }
}
