import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isClaudeSessionId } from "../core/resume.ts";
import { buildRuntimeArgs } from "../core/runtime-args.ts";
import { CODING_AGENTS, type CodingAgent, RUNTIMES } from "../core/runtimes.ts";
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

// `lh build` provisions an isolated git worktree and launches an interactive Claude session in
// it. Everything here is pure CLI-side policy — it imports git plumbing from core but no DB — so
// it can be unit-tested and later moved to a swappable same-repo runner without touching core.

export function validateRepo(repo: string): void {
  if (repo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`invalid --repo "${repo}" (expected owner/name)`);
  }
}

// ---- interactive launch args ----
//
// Build the `claude` argv for the interactive dev session. Auto mode (`--permission-mode auto`)
// is enabled only when the caller explicitly passes `--auto` (never by default); without it the
// session starts in Claude's normal approval mode.
// `auto` (vs `acceptEdits`) lets the session run Bash/network/edits without prompting — driven
// by Claude's safety classifier, which still stops to confirm genuinely destructive actions
// (force push, `terraform destroy`, `curl | bash`, …) — so an unattended dev loop is not blocked
// on routine approvals. Centralized here so the displayed spawn command line (formatSpawnCommand)
// and the real spawn share one source of truth.
// Parse a target-taking command's positional target. Two accepted forms:
//   <id>                  e.g. "116"            → { id: 116 }            (repo from cwd/--repo)
//   <owner>/<repo>/<id>   e.g. "jugyo/lh/116"   → { repo: "jugyo/lh", id: 116 }
// The owner/repo/id form lets a command start from outside the target repo's working directory
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

export function reconcileTargetRepo(
  parsedRepo: string | undefined,
  flagRepo: string | undefined,
): string | undefined {
  if (parsedRepo === flagRepo) return parsedRepo;
  if (parsedRepo && flagRepo) {
    throw new Error(
      `conflicting repo: positional '${parsedRepo}' vs --repo '${flagRepo}'`,
    );
  }
  return parsedRepo ?? flagRepo;
}

// ---- runtime selection ----
//
// A dev session can launch the interactive runtime in Claude Code (default), Codex (#458), or
// Grok. The worktree/PR/session preparation is runtime-independent; only the final spawn
// differs. DevRuntime is the CLI-side alias of the core runtime id (core/runtimes.ts CodingAgent) —
// the two are the same set of values, kept as one type here so the union isn't declared twice.
export type DevRuntime = CodingAgent;

// Resolve the runtime from the mutually-exclusive `--claude-code` / `--codex` / `--grok` flags.
// Passing more than one is ambiguous — fail loudly rather than pick one. When no flag is passed,
// `defaultRuntime` (the `codingAgent` app setting, #516) decides; omitting it too falls back to the
// historical default (Claude Code), so the resolved runtime is unchanged for callers that
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
// positional (`codex [PROMPT]`), so the same slash command Claude receives is
// handed to Codex verbatim — the rest of the context (worktree cwd, registered session, linked
// PR) is prepared before spawn and is runtime-independent. Codex has no `--session-id` /
// `--name` / `--settings` equivalents. Sandboxed launches receive a Codex config override that
// grants LOOPHUB_HOME as a writable root; claude-only flags (--sandbox/--allow) are rejected up
// front by the CLI, not silently dropped here.
export function buildCodexArgs({
  slashCommand,
  auto,
  model,
  effort,
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
  // Reasoning effort (`-c model_reasoning_effort=<level>`, #682/#1534). Same Codex config override
  // the scheduled-task launcher uses. Omitted => codex's own default.
  effort?: string;
  // Effective LOOPHUB_HOME to grant as a Codex sandbox writable root. Defaults to the same
  // configDir() resolution used by LoopHub DB/config writes.
  loopHubHome?: string;
}): string[] {
  return buildRuntimeArgs({
    runtime: "codex",
    auto,
    model,
    effort,
    loopHubHome,
    prompt: slashCommand,
  });
}

// Build the `grok` argv for the interactive dev session. Mirrors buildCodexArgs: grok takes the
// initial prompt as a positional, so the same slash command the other runtimes
// receive is handed to grok verbatim — the rest of the context (worktree cwd, registered session,
// linked PR) is prepared before spawn and is runtime-independent. grok has no sandbox concept
// (claude-only --sandbox/--allow are rejected up front by the CLI, same as codex) and no
// --session-id / --name / --settings equivalent.
//
// Grok's auto-mode equivalent is `--always-approve` (auto-approve all tool executions), matching
// Claude Code's `--permission-mode auto` and Codex's `--dangerously-bypass-approvals-and-sandbox`.
// An older tentative flag (`--force`) is rejected by current `grok` CLIs as unknown, which made
// Web Start workflow (`--auto`) exit the agent pane immediately with status 2 (#1540).
export function buildGrokArgs({
  slashCommand,
  auto,
  model,
}: {
  slashCommand: string;
  // Opt into grok's auto-mode equivalent: skip approval prompts and auto-run tools, matching Claude
  // Code's --auto (`--permission-mode auto`) and Codex's --dangerously-bypass-approvals-and-sandbox.
  auto?: boolean;
  // Model for the session (`--model <name>`). No name validation — an unknown name is the grok CLI's
  // error to raise. Omitted => grok's own default. Control characters are stripped (see display()),
  // same invariant as buildCodexArgs' model.
  model?: string;
  // effort is accepted on the launch path (#1534) but not forwarded: grok has no verified
  // user-facing reasoning-effort flag yet (see core/runtimes.ts effortSuggestions note).
}): string[] {
  return buildRuntimeArgs({
    runtime: "grok",
    auto,
    model,
    prompt: slashCommand,
  });
}

export function buildClaudeArgs({
  sessionId,
  auto,
  slashCommand,
  sessionName,
  model,
  effort,
}: {
  sessionId: string;
  // Opt into auto mode (`--permission-mode auto`). Enabled only when explicitly requested (never
  // by default); without it the session starts in Claude's normal approval mode.
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
  // Reasoning effort (`--effort <level>`, #682/#1534). Mirrors the Settings screen's effort
  // levels for claude-code. Omitted => claude's own default.
  effort?: string;
}): string[] {
  return buildRuntimeArgs({
    runtime: "claude-code",
    sessionId,
    auto,
    sessionName,
    model,
    effort,
    prompt: slashCommand,
  });
}

// The interactive launch input shared by every runtime; buildRuntimeArgs (core) turns it into the
// runtime's argv, keyed by the registry rather than a branch here.
type RuntimeArgvInput = {
  sessionId: string;
  auto?: boolean;
  slashCommand: string;
  sessionName?: string;
  model?: string;
  effort?: string;
};

export function buildRuntimeLaunch({
  runtime,
  sessionId,
  auto,
  slashCommand,
  sessionName,
  model,
  effort,
}: RuntimeArgvInput & {
  runtime: DevRuntime;
}): { bin: "claude" | "codex" | "grok"; args: string[] } {
  return {
    bin: RUNTIMES[runtime].bin,
    args: buildRuntimeArgs({
      runtime,
      sessionId,
      auto,
      sessionName,
      model,
      effort,
      prompt: slashCommand,
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
// A dev-session worktree is deterministic per PR (#463 — previously per issue), so a second
// dev session targeting the same PR reuses the *same* worktree — two live sessions editing one tree
// clobber each other. We guard this with a lock file keyed by (repo, PR) under LOOPHUB_HOME
// recording the running dev-session process: the launcher runs `claude` via a blocking `spawnSync`,
// so the `lh` process is alive for exactly the session's lifetime, making its PID a precise
// liveness signal. A new launch that finds a lock whose PID is still alive refuses (unless
// --force); one whose PID is gone (crash / Ctrl-C) treats it as stale and reclaims it — so a
// finished/interrupted session never blocks a relaunch. Keying by PR (not issue) means two PRs
// linked to the same issue can run dev sessions concurrently without colliding; a second
// concurrent dev session racing to open the *first* PR for that issue is not separately
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
// so a corrupt or partial lock never wedges a dev-session launch — it's treated as free and
// reclaimed. The full shape is validated (not just `pid`), so a truncated `{"pid":N}` doesn't
// slip through and surface as `undefined` fields in the block message.
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
