import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { baseUrl, configDir, dbPath, worktreeRoot } from "../core/config.ts";
import { gitCommonDir, gitDirOf } from "../core/git.ts";
import {
  ENV_ISSUE_CREATE_SESSION,
  LH_DEV_SESSION_AGENT,
  LH_ISSUE_CREATE_SESSION_AGENT,
  RUNTIME_CLAUDE_CODE,
  SESSION_KIND_ISSUE_CREATE,
} from "../core/resume.ts";
import {
  acquireDevLock,
  buildClaudeArgs,
  buildKaniLaunch,
  buildManagedSettings,
  buildResumeArgs,
  devLockPath,
  displayMultiline,
  formatLaunchPlan,
  formatLaunchSummary,
  formatSpawnCommand,
  parseDevTarget,
  pidAlive,
  provisionWorktree,
  removeDevLock,
  resolveAllowedDomains,
  validateRepo,
  worktreeBranch,
  worktreePath,
} from "./dev.ts";

// Lazily load the service layer (which opens the DB at import time) so DB-free commands
// like `lh` (usage) never touch ~/.loophub.
type Service = typeof import("../core/service.ts");
let _svc: Service | null = null;
async function svc(): Promise<Service> {
  if (!_svc) _svc = await import("../core/service.ts");
  return _svc;
}

// ---- arg parsing ----
// Declare each flag's type so boolean flags (--sandbox/--verbose/--json) never swallow the
// next token: `lh dev --sandbox 123` and `lh dev 123 --sandbox` parse identically, and
// `--repo=me/x` works. strict:false keeps the old lenient behavior for any undeclared flag.
type Flags = {
  repo?: string;
  "session-id"?: string;
  sessionId?: string;
  sandbox?: boolean;
  auto?: boolean;
  verbose?: boolean;
  kani?: boolean;
  force?: boolean;
  draft?: boolean;
  json?: boolean;
  allow?: string;
  path?: string;
  name?: string;
  // string when a value is given (--archived all|true|false); boolean true when bare
  // (--archived), since strict:false resolves a value-less declared flag to true.
  archived?: string | boolean;
  "default-branch"?: string;
  state?: string;
  label?: string;
  title?: string;
  body?: string;
  id?: string;
  agent?: string;
  session?: string;
  runtime?: string;
  head?: string;
  base?: string;
  issue?: string;
  method?: string;
  comments?: string;
  commit?: string;
  event?: string;
  topic?: string;
  since?: string;
  order?: string;
  follow?: boolean;
  add?: string;
  yes?: boolean;
  "dry-run"?: boolean;
  kind?: string;
  summary?: string;
  pr?: string;
  file?: string[];
  actor?: string;
  input?: string;
  status?: string;
  limit?: string;
  phase?: string;
  dir?: string;
  src?: string;
  from?: string;
  to?: string;
  hash?: string;
  model?: string;
  cost?: string;
  number?: string;
  url?: string;
  branch?: string;
};
const { values, positionals: pos } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    repo: { type: "string" },
    "session-id": { type: "string" },
    sessionId: { type: "string" },
    sandbox: { type: "boolean" },
    auto: { type: "boolean" },
    verbose: { type: "boolean" },
    kani: { type: "boolean" },
    force: { type: "boolean" },
    draft: { type: "boolean" },
    json: { type: "boolean" },
    allow: { type: "string" },
    path: { type: "string" },
    name: { type: "string" },
    archived: { type: "string" },
    "default-branch": { type: "string" },
    state: { type: "string" },
    label: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    id: { type: "string" },
    agent: { type: "string" },
    session: { type: "string" },
    runtime: { type: "string" },
    head: { type: "string" },
    base: { type: "string" },
    issue: { type: "string" },
    method: { type: "string" },
    comments: { type: "string" },
    commit: { type: "string" },
    event: { type: "string" },
    topic: { type: "string" },
    since: { type: "string" },
    order: { type: "string" },
    follow: { type: "boolean", short: "f" },
    add: { type: "string" },
    yes: { type: "boolean" },
    "dry-run": { type: "boolean" },
    kind: { type: "string" },
    summary: { type: "string" },
    pr: { type: "string" },
    file: { type: "string", multiple: true },
    actor: { type: "string" },
    input: { type: "string" },
    status: { type: "string" },
    limit: { type: "string" },
    phase: { type: "string" },
    dir: { type: "string" },
    src: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    hash: { type: "string" },
    model: { type: "string" },
    cost: { type: "string" },
    number: { type: "string" },
    url: { type: "string" },
    branch: { type: "string" },
  },
});
const flags = values as Flags;

// Human CLI persists a default session; agents pass --session-id explicitly.
const SESSION_ID = flags["session-id"] || flags.sessionId;
let humanSessionId: string | null = null;

function humanSessionPath() {
  return join(configDir(), "human-session.json");
}

// Resolve/create the persistent human session and ensure it's registered.
async function ensureHumanSession(): Promise<string> {
  if (humanSessionId) return humanSessionId;
  const path = humanSessionPath();
  let id: string;
  if (existsSync(path)) {
    id = JSON.parse(readFileSync(path, "utf8")).id;
  } else {
    id = randomUUID();
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ id, agent: "me", session: "cli" }, null, 2)}\n`,
    );
  }
  const s = await svc();
  s.sessions.register({ id, agent: "me", session: "cli" });
  humanSessionId = id;
  return id;
}

// Session id used to attribute a write: explicit --session-id, otherwise the human session.
async function writeSession(): Promise<string> {
  if (SESSION_ID) return SESSION_ID;
  return ensureHumanSession();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// One-word status label for a PR in `lh pr list` / `view` (#413). "draft" only applies to an open WIP
// PR — a draft closed before ready-for-review reads as "closed", not "draft" (mirrors the web
// draftBadge guard, which gates on `state === "open"`).
function prStatusLabel(p: {
  merged?: boolean;
  draft?: boolean;
  state: string;
}): string {
  if (p.merged) return "merged";
  if (p.state === "open" && p.draft) return "draft";
  return p.state;
}

function display(v: string): string {
  return stripVTControlCharacters(v).replace(/[\x00-\x1f\x7f]/g, "");
}

// Compact "2h ago" / "3d ago" style relative time for human-facing list output.
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [7, "d"],
    [Number.POSITIVE_INFINITY, "w"],
  ];
  let value = sec;
  for (const [size, label] of units) {
    if (value < size) return `${value}${label} ago`;
    value = Math.floor(value / size);
  }
  return `${value}w ago`;
}

// Run a service call, translating ServiceError (status + message) into the CLI error line.
async function run<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (typeof e?.status === "number") fail(`error ${e.status}: ${e.message}`);
    throw e;
  }
}

// --repo, or inferred from cwd.
async function resolveRepo(): Promise<string> {
  if (flags.repo) return flags.repo;
  const s = await svc();
  const repos = s.repos.list("all");
  const cwd = resolve(process.cwd());
  const hit = repos.find((r) => resolve(r.local_path) === cwd);
  if (hit) return hit.full_name;
  fail(
    "Cannot determine the repo. Pass --repo owner/name or run from the repo root.",
  );
}

function out(v: any) {
  if (flags.json) console.log(JSON.stringify(v, null, 2));
  return v;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Yes/no prompt on the TTY for destructive confirmation; defaults to no on EOF or a blank line.
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// ---- commands ----
const [group, sub, ...rest] = pos;

async function main() {
  if (group === "info") {
    // DB-free: report resolved environment so skills don't read ~/.loophub/config.json directly.
    const info = { baseUrl: baseUrl(), home: configDir(), dbPath: dbPath() };
    if (flags.json) out(info);
    else {
      console.log(`baseUrl\t${info.baseUrl}`);
      console.log(`home\t${info.home}`);
      console.log(`dbPath\t${info.dbPath}`);
    }
    return;
  }

  if (group === "dev" && sub === "note") {
    // Record a development note (decision/action/assumption/blocker) on the issue's PR.
    const noteUsage =
      "usage: lh dev note --kind <decision|action|assumption|blocker> --summary <text> [--body <text>] [--issue <n>] [--pr <n>] [--repo owner/name]";
    if (!flags.kind || !flags.summary) fail(noteUsage);
    if (!flags.issue && !flags.pr)
      fail(`--issue or --pr is required\n${noteUsage}`);
    const repo = await resolveRepo();
    const s = await svc();
    const session = await writeSession();
    const note = await run(() =>
      s.dev.note(
        repo,
        {
          kind: flags.kind as string,
          summary: flags.summary as string,
          body: flags.body,
          issue: flags.issue ? Number(flags.issue) : undefined,
          pr: flags.pr ? Number(flags.pr) : undefined,
        },
        session,
      ),
    );
    if (flags.json) out(note);
    else {
      const target = note.pr_number
        ? `PR #${note.pr_number}`
        : `issue #${note.issue_number}`;
      console.log(`recorded ${note.kind} on ${target}: ${note.summary}`);
    }
    return;
  }

  if (group === "dev") {
    const target = sub;
    const usageLine =
      "usage: lh dev <owner>/<repo>/<id> | <id> [--repo owner/name] [--sandbox [--allow d1,d2]] [--auto] [--verbose] [--kani] [--force]";
    if (!target) {
      fail(usageLine);
    }
    // Parse the positional: bare <id> defers repo resolution to resolveRepo(); the
    // <owner>/<repo>/<id> form carries the repo so `lh dev` can run from outside that repo.
    let parsed: { repo?: string; id: number };
    try {
      parsed = parseDevTarget(target);
    } catch (e: any) {
      fail(`${e.message}\n${usageLine}`);
    }
    // Resolve the repo: a repo from the positional takes precedence but must not contradict an
    // explicit --repo (a conflict is a hard error rather than a silent pick). Without a positional
    // repo, fall back to the existing resolution (--repo, else cwd match).
    let repo: string;
    if (parsed.repo) {
      if (flags.repo && flags.repo !== parsed.repo) {
        fail(
          `conflicting repo: positional '${parsed.repo}' vs --repo '${flags.repo}'`,
        );
      }
      repo = parsed.repo;
    } else {
      repo = await resolveRepo();
    }
    const n = parsed.id;
    const issue = String(n);
    const sessionId = randomUUID();
    const slashCommand = `/lh-dev ${issue}`;

    // Validate --allow vs --sandbox flag early.
    const useSandbox = flags.sandbox === true;
    if (flags.allow && !useSandbox) {
      fail("--allow can only be used with --sandbox");
    }

    // Validate --repo up front, before any side effects (provisioning a worktree).
    try {
      validateRepo(repo);
    } catch (e: any) {
      fail(e.message);
    }

    // When sandbox is enabled, validate --allow and log sandbox context.
    let allowedDomains: string[] | undefined;
    if (useSandbox) {
      try {
        allowedDomains = resolveAllowedDomains(flags.allow);
      } catch (e: any) {
        fail(e.message);
      }
      // Sandbox context (repo + allowed domains) to stderr only when sandbox enabled.
      console.error(`repo: ${repo}`);
      console.error(`allowed-domains: ${allowedDomains.join(", ")}`);
    }

    // Resolve the repo record + issue kind, then provision the worktree (outside the sandbox).
    const s = await svc();
    const r = await run(() => s.repos.get(repo));
    const item = await run(() => s.issues.get(repo, n));

    // --kani: relaunch the dev loop in a fresh kani terminal instead of the foreground. The
    // inner `lh dev` (without --kani) provisions the worktree and spawns claude itself, so we
    // do neither here — just launch the terminal and report its id. r.local_path is the main
    // checkout root the inner command resolves the repo from.
    if (flags.kani === true) {
      const launch = buildKaniLaunch({
        issue: n,
        title: item.title,
        cwd: r.local_path,
        flags: {
          // Forward the fully-resolved repo (not the raw --repo flag) so the inner `lh dev`
          // gets it explicitly regardless of which positional form launched this one.
          repo,
          sandbox: flags.sandbox,
          auto: flags.auto,
          allow: flags.allow,
          verbose: flags.verbose,
          // Carry --force through the relaunch so the inner `lh dev` still overrides the lock.
          force: flags.force,
        },
      });
      const proc = spawnSync("kani", launch.argv, { stdio: "inherit" });
      if (proc.error) {
        const err = proc.error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          fail("failed to launch kani terminal: 'kani' not found on PATH");
        }
        fail(`failed to launch kani terminal: ${err.message}`);
      }
      process.exit(proc.status ?? 0);
    }

    // Duplicate-launch guard: atomically claim this issue's worktree before any side effect
    // (provisioning). The worktree path/branch are deterministic from the issue number, so a
    // second concurrent `lh dev <n>` would share the same tree and clobber edits. acquireDevLock
    // exclusively creates the lock recording this process's pid; if a *live* `lh dev` already
    // holds it we refuse (unless --force). A stale lock (the previous session crashed / was
    // interrupted, so its pid is gone) is reclaimed, so a finished session never blocks a
    // relaunch. Host-local by design (cross-host exclusion is out of scope). The exit handler is
    // registered immediately so the lock is released even if provisioning below fails.
    const lockPath = devLockPath(configDir(), r.full_name, n);
    const wtPath = worktreePath(worktreeRoot(), r.full_name, n);
    const claim = acquireDevLock(
      lockPath,
      {
        pid: process.pid,
        issue: n,
        worktree: wtPath,
        sessionId,
        startedAt: new Date().toISOString(),
      },
      pidAlive,
      { force: flags.force === true },
    );
    if (!claim.ok) {
      const l = claim.held;
      fail(
        `issue #${n} is already being worked on by another \`lh dev\` session ` +
          `(pid ${l.pid}, since ${l.startedAt}).\n` +
          `  worktree: ${wtPath}\n` +
          `Launching a second session would share this worktree and clobber edits. ` +
          `Wait for that session to finish, or pass --force to launch anyway.`,
      );
    }
    process.on("exit", () => removeDevLock(lockPath));

    const headRef = item.pull_request
      ? (await run(() => s.pulls.get(repo, n))).head.ref
      : null;
    let worktree: string;
    try {
      worktree = await provisionWorktree({
        repoPath: r.local_path,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        worktreeRoot: worktreeRoot(),
        issue: n,
        headRef,
      });
    } catch (e: any) {
      fail(e.message);
    }

    // Display issue content before the launch plan so the user sees what they're about to work on.
    // By default keep this minimal — just the `#<n> <title>` header. The full details (state/user,
    // labels, linked PR, and the issue body) are noise on every launch, so they're gated behind
    // --verbose (#383).
    if (flags.verbose) {
      const line = `#${item.number} ${display(item.title)} [${item.state}] @${display(item.user.login)}`;
      console.error(line);
      if (item.labels && item.labels.length > 0) {
        const labelNames = item.labels
          .map((l: any) => display(l.name))
          .join(", ");
        console.error(`labels: ${labelNames}`);
      }
      if (item.linked_pull_request) {
        const pr = item.linked_pull_request;
        console.error(
          `linked PR #${pr.number} (${pr.merged ? "merged" : display(pr.state)})`,
        );
      }
      console.error();
      console.error(displayMultiline(item.body));
    } else {
      console.error(`#${item.number} ${display(item.title)}`);
    }
    console.error();

    // Build the sandbox managed-settings only when --sandbox is enabled.
    // When sandbox is disabled (default), managed will be undefined.
    let managed: string | undefined;
    if (useSandbox) {
      try {
        const [gitDir, worktreeGitDir] = await Promise.all([
          gitCommonDir(worktree),
          gitDirOf(worktree),
        ]);
        const branch = headRef ?? worktreeBranch(n);
        ({ json: managed } = buildManagedSettings({
          repo,
          allow: flags.allow,
          git: { gitDir, worktreeGitDir, branch },
        }));
      } catch (e: any) {
        fail(e.message);
      }
    }
    // Make the work visible: register this session before spawning. The runtime session id is the
    // Claude session we are about to spawn (unique per run, so re-launching the same issue never
    // collides on the (agent, session) pair).
    await run(() =>
      s.sessions.register({
        id: sessionId,
        agent: LH_DEV_SESSION_AGENT,
        session: sessionId,
        // The session we are about to spawn is a Claude Code session; record the runtime so
        // `lh resume` picks `claude --resume` by runtime rather than inferring it from the agent.
        runtime: RUNTIME_CLAUDE_CODE,
        // This is an implementation (dev) session; record its kind (#298) so it surfaces in the
        // PR's related-sessions list as a dev session. (setPullSession also stamps 'dev' when it
        // attributes the session to the PR — this just sets it at the registration point too.)
        kind: "dev",
      }),
    );

    // Attribute this session to the work's PR (via session_links, #316) so `lh resume`/retro can
    // later re-enter it (#186 — replaces the old issue-assignee path). For an issue target, open (or reuse)
    // the draft PR so the agent has a place to write its plan and dev notes; for a PR target, point
    // the existing PR at this session. Best-effort: a failure warns rather than blocks the dev loop.
    // Capture the resolved PR number so the session name below can be built from it (#336): for a PR
    // target it is the target itself (`item.number`); for an issue target it is the PR openPr resolves.
    let prNumber: number | undefined = item.pull_request
      ? item.number
      : undefined;
    if (!item.pull_request) {
      try {
        const res = await s.dev.openPr(
          repo,
          {
            issue: n,
            head: worktreeBranch(n),
            base: r.default_branch,
          },
          sessionId,
        );
        prNumber = res.number;
        console.error(
          res.created
            ? `draft PR #${res.number} opened`
            : `using existing PR #${res.number}`,
        );
      } catch (e: any) {
        console.error(`warning: could not open draft PR: ${e.message}`);
      }
    } else {
      try {
        await s.dev.attachSession(repo, n, sessionId);
      } catch (e: any) {
        console.error(`warning: could not attach session to PR: ${e.message}`);
      }
    }

    // Set the session display name to the PR being worked on so the session picker / terminal title
    // shows the linked PR (#336). The name is built only after openPr/attachSession above so the PR
    // number is known; if the PR couldn't be resolved (e.g. openPr failed) we fall back to the issue
    // number so `lh dev` still launches. buildClaudeArgs strips control chars from the title before argv.
    const sessionName = `#${prNumber ?? item.number} ${item.title}`;
    const claudeArgs = buildClaudeArgs({
      sessionId,
      managedSettings: managed,
      // --auto enables auto mode without the sandbox; --sandbox already implies it via managed.
      auto: flags.auto === true,
      slashCommand,
      sessionName,
    });

    // Show what `claude` will receive, then launch immediately (no confirmation prompt). By
    // default only the basic context (repo / worktree / branch / session-id) is shown; the full
    // managed-settings/sandbox launch plan is a safety artifact reserved for --verbose (#383).
    if (flags.verbose) {
      console.error(
        formatLaunchPlan({
          repo,
          worktree,
          sessionId,
          slashCommand,
          managedSettings: managed ?? "{}",
          claudeArgs,
        }),
      );
    } else {
      console.error(
        formatLaunchSummary({
          repo,
          worktree,
          branch: headRef ?? worktreeBranch(n),
          sessionId,
        }),
      );
    }
    // Always show the exact command being spawned as the last line of the launch output, in
    // dim/gray, so a normal launch (no --verbose) still reveals and lets you copy what runs.
    // This supersedes the old --verbose-only `exec:` line — unified into one always-on display.
    // Built from `claudeArgs` (the same argv handed to spawnSync below) for an exact match.
    console.error(
      formatSpawnCommand(claudeArgs, { color: process.stderr.isTTY === true }),
    );

    // The lock claimed above holds our pid for the session's lifetime (the spawnSync below blocks
    // until claude exits); the exit handler releases it. Release is best-effort — if the process
    // is killed before it runs, the stale lock self-heals (its pid is gone, so the next launch
    // reclaims it).
    const proc = spawnSync("claude", claudeArgs, {
      stdio: "inherit",
      cwd: worktree,
    });
    process.exit(proc.status ?? 0);
  }

  if (group === "resume") {
    // `lh resume --session <id>` re-enters a session by its id (#299), for sessions with no PR/dev
    // worktree — chiefly the `issue-create` session `lh issue new` records. No worktree to restore:
    // resolve the runtime + id and spawn `claude --resume <id>` in the repo root. The issue detail's
    // related-sessions Resume button runs exactly this. Checked before the PR-positional path below.
    if (flags.session) {
      const sessionId = flags.session;
      const s = await svc();
      const resolution = await run(() => s.resume.resolveSession(sessionId));
      if (!resolution.ok) {
        if (resolution.reason === "not-found")
          fail(`no session recorded with id ${sessionId}.`);
        if (resolution.reason === "unknown-runtime")
          fail(
            `session ${sessionId} uses a runtime this version of \`lh resume\` cannot ` +
              `resume (only \`${RUNTIME_CLAUDE_CODE}\` is supported).`,
          );
        fail(
          `session ${sessionId}: no resumable Claude session id is recorded, so there is ` +
            `nothing to resume.`,
        );
      }
      // cwd = repo root when --repo is given (an issue-create session has no worktree); else inherit
      // the current directory. resolveRepo() would 404 outside a known repo, so --repo is optional.
      let cwd: string | undefined;
      if (flags.repo) {
        const repoArg = flags.repo;
        const r = await run(() => s.repos.get(repoArg));
        cwd = r.local_path;
      }
      const claudeArgs = buildResumeArgs({ sessionId: resolution.sessionId });
      console.error(`resuming session ${resolution.sessionId}`);
      console.error(
        formatSpawnCommand(claudeArgs, {
          color: process.stderr.isTTY === true,
        }),
      );
      const proc = spawnSync("claude", claudeArgs, { stdio: "inherit", cwd });
      process.exit(proc.status ?? 0);
    }
    // `lh resume <PR id>` re-enters the Claude session a PR was developed in. Resolution
    // (session id + worktree/branch + restorability) lives in core (service.resume.resolve);
    // the CLI provisions the worktree (idempotent restore) and spawns `claude --resume`, mirroring
    // the `lh dev` spawn (inherited env carries the NODE_OPTIONS conventions; cwd = worktree).
    const target = sub;
    const usageLine =
      "usage: lh resume <owner>/<repo>/<pr> | <pr> [--repo owner/name]";
    if (!target) fail(usageLine);
    // The positional accepts the same forms as `lh dev`: a bare <pr> (repo from --repo/cwd) or
    // <owner>/<repo>/<pr> (carries the repo so resume can run from outside the checkout).
    let parsed: { repo?: string; id: number };
    try {
      parsed = parseDevTarget(target);
    } catch (e: any) {
      fail(`${e.message}\n${usageLine}`);
    }
    let repo: string;
    if (parsed.repo) {
      if (flags.repo && flags.repo !== parsed.repo) {
        fail(
          `conflicting repo: positional '${parsed.repo}' vs --repo '${flags.repo}'`,
        );
      }
      repo = parsed.repo;
    } else {
      repo = await resolveRepo();
    }
    const prNumber = parsed.id;
    try {
      validateRepo(repo);
    } catch (e: any) {
      fail(e.message);
    }

    const s = await svc();
    const r = await run(() => s.repos.get(repo));
    const resolution = await run(() => s.resume.resolve(repo, prNumber));
    if (!resolution.ok) {
      if (resolution.reason === "no-session") {
        fail(
          `PR #${prNumber}: no Claude session is recorded for this PR, so there is nothing to ` +
            `resume.\n(A resumable session id is saved when work starts via \`lh dev\`.)`,
        );
      }
      if (resolution.reason === "unknown-runtime") {
        fail(
          `PR #${prNumber}: its dev session uses runtime \`${resolution.runtime}\`, which this ` +
            `version of \`lh resume\` cannot resume (only \`${RUNTIME_CLAUDE_CODE}\` is supported).`,
        );
      }
      fail(
        `PR #${prNumber}: cannot restore the dev worktree — its branch ` +
          `\`${resolution.branch}\` no longer exists (and no worktree remains). ` +
          `The work cannot be resumed.`,
      );
    }

    // Idempotent worktree restore: reuse the existing worktree, or re-attach it from the surviving
    // branch (same provisionWorktree path `lh dev` uses for a removed-but-branch-present worktree).
    let worktree: string;
    try {
      worktree = await provisionWorktree({
        repoPath: r.local_path,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        worktreeRoot: worktreeRoot(),
        issue: resolution.issue,
        headRef: resolution.branch,
      });
    } catch (e: any) {
      fail(e.message);
    }

    // Select the resume command by the session's runtime. resume.resolve only returns ok for a
    // supported runtime, so claude-code is exhaustive today; a new runtime adds a branch here.
    if (resolution.runtime !== RUNTIME_CLAUDE_CODE) {
      fail(
        `PR #${prNumber}: unsupported runtime \`${resolution.runtime}\` for resume.`,
      );
    }
    const claudeArgs = buildResumeArgs({ sessionId: resolution.sessionId });
    console.error(`resuming PR #${prNumber} (session ${resolution.sessionId})`);
    console.error(`  repo:     ${repo}`);
    console.error(
      `  worktree: ${worktree}${resolution.restore ? " (restored from branch)" : ""}`,
    );
    console.error(
      formatSpawnCommand(claudeArgs, { color: process.stderr.isTTY === true }),
    );
    const proc = spawnSync("claude", claudeArgs, {
      stdio: "inherit",
      cwd: worktree,
    });
    process.exit(proc.status ?? 0);
  }

  if (group === "repo") {
    const s = await svc();
    if (sub === "add") {
      const path = resolve(rest[0] || flags.path || process.cwd());
      const name = flags.name || `me/${path.split("/").pop()}`;
      const r = await run(() => s.repos.create({ path, name }));
      console.log(`added ${r.full_name}  (${r.local_path})`);
    } else if (sub === "list") {
      // Bare `--archived` resolves to boolean true under strict:false; treat it like the
      // old parser's "true" so `lh repo list --archived` still lists archived repos.
      const archived =
        flags.archived === "true" || flags.archived === true
          ? "archived"
          : flags.archived === "all"
            ? "all"
            : "active";
      const repos = s.repos.list(archived);
      out(repos);
      if (!flags.json)
        repos.forEach((r) => {
          console.log(
            `${r.archived ? "[archived] " : ""}${r.full_name}\t${r.local_path}`,
          );
        });
    } else if (sub === "archive" || sub === "unarchive") {
      const name = rest[0] || flags.repo;
      if (!name) fail("owner/name is required");
      const r = await run(async () =>
        s.repos.setArchived(name, sub === "archive", await writeSession()),
      );
      console.log(`${sub}d ${r.full_name}`);
    } else if (sub === "update") {
      const name = flags.repo || rest[0];
      if (!name)
        fail(
          "usage: lh repo update --repo owner/name [--default-branch main] [--path /abs/path]",
        );
      const fields: { default_branch?: string; local_path?: string } = {};
      if (flags["default-branch"])
        fields.default_branch = flags["default-branch"];
      if (flags.path) fields.local_path = resolve(flags.path);
      if (!fields.default_branch && !fields.local_path)
        fail("at least one of --default-branch or --path is required");
      const r = await run(() => s.repos.update(name, fields));
      console.log(
        `updated ${r.full_name}  default_branch=${r.default_branch}  (${r.local_path})`,
      );
    } else if (sub === "remove") {
      const name = flags.repo || rest[0];
      if (!name) fail("usage: lh repo remove --repo owner/name");
      await run(() => s.repos.remove(name));
      console.log(`removed ${name}`);
    } else if (sub === "merge-mode") {
      // #406: show or set the repo's PR-detail write action. No mode arg → show the resolved view;
      // a mode arg (merge | github_pr | auto) pins or clears it.
      const name = flags.repo || rest[0];
      if (!name)
        fail(
          "usage: lh repo merge-mode --repo owner/name [merge|github_pr|auto]",
        );
      const mode = (flags.repo ? rest[0] : rest[1]) as
        | "merge"
        | "github_pr"
        | "auto"
        | undefined;
      if (mode) {
        const r = await run(async () =>
          s.repos.setMergeMode(name, mode, await writeSession()),
        );
        console.log(`${r.full_name} merge_mode=${r.merge_mode ?? "auto"}`);
      } else {
        const m = await run(() => s.repos.mergeMode(name));
        out(m);
        if (!flags.json)
          console.log(
            `setting=${m.setting ?? "auto"}  github_remote=${m.has_github_remote}  effective=${m.effective}`,
          );
      }
    } else usage();
    return;
  }

  if (group === "issue") {
    const s = await svc();
    const repo = await resolveRepo();
    if (sub === "list") {
      const state = flags.state || "open";
      const items = await s.issues.list(repo, { state });
      const issues = items.filter((i: any) => !i.pull_request);
      out(issues);
      if (!flags.json)
        issues.forEach((i: any) => {
          const labels = (i.labels || []).map((l: any) => l.name).join(",");
          console.log(
            `#${i.number}\t${i.state}\t${i.title}\t${labels}\t${relativeTime(i.updated_at)}`,
          );
        });
    } else if (sub === "view") {
      const i = await run(() => s.issues.get(repo, Number(rest[0])));
      out(i);
      if (!flags.json) {
        let line = `#${i.number} ${i.title} [${i.state}] @${i.user.login}`;
        if (i.linked_pull_request) {
          const pr = i.linked_pull_request;
          line += `\nlinked PR #${pr.number} (${pr.merged ? "merged" : pr.state})`;
        }
        console.log(`${line}\n\n${i.body}`);
      }
    } else if (sub === "new") {
      // `lh issue new` files an issue *with an AI session* (#299): it launches a Claude session
      // running the `/lh-issue-create` skill, recorded as kind=issue-create so it surfaces in the
      // created issue's related-sessions list and can be resumed later. The New Issue button runs
      // this. Mirrors `lh dev`: register the session, then spawn `claude --session-id <id>` — here
      // in the repo root (no worktree; filing an issue does not touch a branch).
      const r = await run(() => s.repos.get(repo));
      const sessionId = randomUUID();
      const slashCommand = "/lh-issue-create";
      await run(() =>
        s.sessions.register({
          id: sessionId,
          agent: LH_ISSUE_CREATE_SESSION_AGENT,
          session: sessionId,
          runtime: RUNTIME_CLAUDE_CODE,
          kind: SESSION_KIND_ISSUE_CREATE,
          name: `New issue (${r.full_name})`,
        }),
      );
      const claudeArgs = buildClaudeArgs({
        sessionId,
        slashCommand,
        sessionName: `New issue (${r.full_name})`,
      });
      console.error(
        formatSpawnCommand(claudeArgs, {
          color: process.stderr.isTTY === true,
        }),
      );
      // Carry the session id into the spawned Claude via env. A `lh issue create` run inside the
      // session reads it and links the session to whatever issue it files (the number is unknown
      // here, so the link is recorded after creation — see the create branch below).
      const proc = spawnSync("claude", claudeArgs, {
        stdio: "inherit",
        cwd: r.local_path,
        env: { ...process.env, [ENV_ISSUE_CREATE_SESSION]: sessionId },
      });
      process.exit(proc.status ?? 0);
    } else if (sub === "create") {
      const labels = (flags.label || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const i = await run(async () =>
        s.issues.create(
          repo,
          { title: flags.title ?? "", body: flags.body || "", labels },
          await writeSession(),
        ),
      );
      console.log(`created #${i.number}`);
      // When this create runs inside a `lh issue new` AI session, link that session to the issue
      // it just filed (#299) so it appears in the issue's related-sessions list and is resumable.
      // Best-effort: a link failure must not fail the create the user asked for.
      const createSession = process.env[ENV_ISSUE_CREATE_SESSION];
      if (createSession) {
        try {
          await s.sessions.link(repo, {
            sessionId: createSession,
            issue: i.number,
          });
        } catch (e: any) {
          console.error(
            `warning: could not link issue-create session: ${e.message}`,
          );
        }
      }
    } else if (sub === "update") {
      const patch: { title?: string; body?: string } = {};
      if (flags.title !== undefined) patch.title = flags.title;
      if (flags.body !== undefined) patch.body = flags.body;
      if (Object.keys(patch).length === 0)
        fail("--title and/or --body is required");
      const i = await run(async () =>
        s.issues.update(repo, Number(rest[0]), patch, await writeSession()),
      );
      out(i);
      if (!flags.json) console.log(`updated #${i.number}`);
    } else if (sub === "comment") {
      await run(async () =>
        s.comments.create(
          repo,
          Number(rest[0]),
          flags.body ?? "",
          await writeSession(),
        ),
      );
      console.log("commented");
    } else if (sub === "close") {
      await run(async () =>
        s.issues.update(
          repo,
          Number(rest[0]),
          { state: "closed" },
          await writeSession(),
        ),
      );
      console.log("closed");
    } else if (sub === "label") {
      const labels = (flags.add || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      await run(async () =>
        s.issues.addLabels(repo, Number(rest[0]), labels, await writeSession()),
      );
      console.log("labeled");
    } else usage();
    return;
  }

  if (group === "session") {
    const s = await svc();
    if (sub === "register") {
      const { id, agent, session } = flags;
      if (!id || !agent || !session)
        fail("--id, --agent, and --session are required");
      const { session: row } = await run(() =>
        s.sessions.register({
          id,
          agent,
          session,
          ...(flags.name ? { name: flags.name } : {}),
          ...(flags.runtime ? { runtime: flags.runtime } : {}),
          ...(flags.kind ? { kind: flags.kind } : {}),
        }),
      );
      console.log(`registered session ${row.id} (${row.agent})`);
    } else if (sub === "list") {
      const rows = s.sessions.list();
      out(rows);
      if (!flags.json)
        rows.forEach((x: any) => {
          console.log(
            `${x.id}\t${x.agent}\t${x.session}${x.name ? `\t${x.name}` : ""}`,
          );
        });
    } else usage();
    return;
  }

  if (group === "attachment") {
    if (sub === "add") {
      // Files may be given as repeated --file flags and/or positionals.
      const paths = [...(flags.file ?? []), ...rest];
      if (paths.length === 0)
        fail(
          "usage: lh attachment add --file <path> [--file <path> ...] [--actor name]",
        );
      const { saveAttachment } = await import("../core/attachments.ts");
      // Standalone blobs aren't attributed to a session; default to the human "me".
      const author = flags.actor || "me";
      for (const p of paths) {
        const abs = resolve(p);
        if (!existsSync(abs)) fail(`file not found: ${p}`);
        const data = readFileSync(abs);
        const filename = abs.split("/").pop() || abs;
        const r = await run(() => saveAttachment({ data, filename, author }));
        if (flags.json) out(r);
        else {
          console.log(r.markdown);
          console.error(`uploaded ${filename} → ${r.url} (${r.size} bytes)`);
        }
      }
    } else usage();
    return;
  }

  if (group === "pr") {
    const s = await svc();
    const repo = await resolveRepo();
    if (sub === "list") {
      const items = await run(() =>
        s.pulls.list(repo, { state: flags.state || "open" }),
      );
      out(items);
      if (!flags.json)
        items.forEach((p: any) => {
          // draft (#413): an open WIP PR is shown as "draft". Gate on the open state so a draft
          // closed before ready-for-review still reads as "closed", not "draft" (mirrors the web
          // draftBadge guard).
          const status = prStatusLabel(p);
          console.log(
            `#${p.number}\t${status}\t${p.head.ref}->${p.base.ref}\t${p.title}`,
          );
        });
    } else if (sub === "view") {
      const p = await run(() => s.pulls.get(repo, Number(rest[0])));
      out(p);
      if (!flags.json) {
        const status = prStatusLabel(p);
        let line = `#${p.number} ${p.title} [${status}]\n${p.head.ref} -> ${p.base.ref}  mergeable=${p.mergeable_state}`;
        if (p.linked_issue)
          line += `\nlinked issue #${p.linked_issue.number} (${p.linked_issue.state})`;
        console.log(`${line}\n\n${p.body}`);
      }
    } else if (sub === "diff") {
      const files = await run(() => s.pulls.files(repo, Number(rest[0])));
      if (flags.json) out(files);
      else
        files.forEach((f: any) => {
          console.log(
            `--- ${f.filename} (+${f.additions} -${f.deletions})\n${f.patch}`,
          );
        });
    } else if (sub === "create") {
      const p = await run(async () =>
        s.pulls.create(
          repo,
          {
            title: flags.title ?? "",
            body: flags.body || "",
            head: flags.head ?? "",
            base: flags.base || "main",
            ...(flags.issue ? { issue: Number(flags.issue) } : {}),
            ...(flags.draft ? { draft: true } : {}),
          },
          await writeSession(),
        ),
      );
      console.log(`created PR #${p.number}${p.draft ? " (draft)" : ""}`);
    } else if (sub === "update") {
      const patch: { title?: string; body?: string } = {};
      if (flags.title !== undefined) patch.title = flags.title;
      if (flags.body !== undefined) patch.body = flags.body;
      if (Object.keys(patch).length === 0)
        fail("--title and/or --body is required");
      const p = await run(async () =>
        s.pulls.update(repo, Number(rest[0]), patch, await writeSession()),
      );
      out(p);
      if (!flags.json) console.log(`updated PR #${p.number}`);
    } else if (sub === "merge") {
      const r = await run(async () =>
        s.pulls.merge(
          repo,
          Number(rest[0]),
          (flags.method || "squash") as any,
          await writeSession(),
        ),
      );
      console.log(`merged: ${r.sha}`);
    } else if (sub === "record-github-pr") {
      // #406: record the GitHub PR this loophub PR was exported to (used by the create-PR skill).
      if (!flags.number) fail("--number is required (the GitHub PR number)");
      if (!flags.url) fail("--url is required (the GitHub PR URL)");
      const g = await run(async () =>
        s.pulls.recordGithubPull(
          repo,
          Number(rest[0]),
          {
            github_number: Number(flags.number),
            url: flags.url as string,
            ...(flags.branch ? { branch: flags.branch as string } : {}),
          },
          await writeSession(),
        ),
      );
      out(g);
      if (!flags.json)
        console.log(`recorded GitHub PR #${g.number} — ${g.url}`);
    } else if (sub === "create-github-pr") {
      // #411: one command for the create-github-pr skill — push the branch, open a GitHub Draft PR,
      // and record it back. The skill supplies the generated branch/title/body; `--body -` reads the
      // (template-derived) description from stdin to avoid shell-escaping a multi-line HEREDOC.
      if (!flags.branch)
        fail("--branch is required (the content-based GitHub branch name)");
      if (!flags.title) fail("--title is required (the GitHub PR title)");
      if (flags.body === undefined)
        fail("--body is required (- for stdin, or a file path)");
      // Same convention as `--comments`: `-` reads stdin, anything else is a file path. The skill
      // pipes the generated description via `--body -` and a HEREDOC.
      const body =
        flags.body === "-"
          ? await readStdin()
          : readFileSync(flags.body, "utf8");
      const g = await run(async () =>
        s.pulls.createGithubPull(
          repo,
          Number(rest[0]),
          {
            branch: flags.branch as string,
            title: flags.title as string,
            body,
          },
          await writeSession(),
        ),
      );
      out(g);
      if (!flags.json) console.log(`created GitHub PR #${g.number} — ${g.url}`);
    } else if (sub === "review") {
      let comments: any;
      if (flags.comments) {
        const raw =
          flags.comments === "-"
            ? await readStdin()
            : readFileSync(flags.comments, "utf8");
        comments = JSON.parse(raw); // [{ path, line, side?, body }, ...]
      }
      const res = await run(async () =>
        s.reviews.create(
          repo,
          Number(rest[0]),
          {
            event: (flags.event || "comment").toUpperCase(),
            body: flags.body || "",
            ...(flags.topic ? { topic: flags.topic } : {}),
            comments,
          },
          await writeSession(),
        ),
      );
      console.log(`review submitted (${res.comments} line comment(s))`);
    } else if (sub === "note") {
      // Add a review note for a file on a PR's diff. Diff range defaults to the PR's base..head;
      // pass --base/--commit to pin an explicit range.
      if (!flags.path) fail("--path is required");
      if (!flags.body) fail("--body is required");
      const n = await run(async () =>
        s.reviewNotes.create(
          repo,
          {
            pr: Number(rest[0]),
            path: flags.path as string,
            body: flags.body as string,
            ...(flags.base ? { baseSha: flags.base } : {}),
            ...(flags.commit ? { commitSha: flags.commit } : {}),
          },
          await writeSession(),
        ),
      );
      out(n);
      if (!flags.json)
        console.log(`note #${n.id} added on ${n.path} (${n.commit_sha})`);
    } else if (sub === "notes") {
      const notes = await run(() =>
        s.reviewNotes.list(repo, {
          pr: Number(rest[0]),
          ...(flags.path ? { path: flags.path } : {}),
          ...(flags.commit ? { commitSha: flags.commit } : {}),
        }),
      );
      out(notes);
      if (!flags.json)
        notes.forEach((n: any) => {
          console.log(`#${n.id}\t${n.path}\t${n.commit_sha}\t${n.body}`);
        });
    } else if (sub === "note-edit") {
      if (!flags.body) fail("--body is required");
      const n = await run(async () =>
        s.reviewNotes.update(
          repo,
          Number(rest[0]),
          flags.body as string,
          await writeSession(),
        ),
      );
      out(n);
      if (!flags.json) console.log(`note #${n.id} updated`);
    } else if (sub === "note-rm") {
      await run(async () =>
        s.reviewNotes.remove(repo, Number(rest[0]), await writeSession()),
      );
      console.log(`note #${rest[0]} deleted`);
    } else if (sub === "ready-for-review") {
      const p = await run(async () =>
        s.pulls.readyForReview(
          repo,
          Number(rest[0]),
          flags.body || "",
          await writeSession(),
        ),
      );
      console.log(
        `PR #${p.number} marked ready for review (${p.review_state})`,
      );
    } else if (sub === "close") {
      await run(async () =>
        s.pulls.update(
          repo,
          Number(rest[0]),
          { state: "closed" },
          await writeSession(),
        ),
      );
      console.log("closed");
    } else if (sub === "reopen") {
      await run(async () =>
        s.pulls.update(
          repo,
          Number(rest[0]),
          { state: "open" },
          await writeSession(),
        ),
      );
      console.log("reopened");
    } else usage();
    return;
  }

  // Review notes, PR-independent (#216). A note is keyed by (repo, base..commit, path); pass --pr to
  // associate it with a PR (and default the range to that PR's base/head). get/edit/rm take a note id.
  if (group === "note") {
    const s = await svc();
    const repo = await resolveRepo();
    if (sub === "add") {
      if (!flags.path) fail("--path is required");
      if (!flags.body) fail("--body is required");
      if (!flags.pr && (!flags.base || !flags.commit))
        fail("--base and --commit are required (or pass --pr to default them)");
      const n = await run(async () =>
        s.reviewNotes.create(
          repo,
          {
            path: flags.path as string,
            body: flags.body as string,
            ...(flags.base ? { baseSha: flags.base } : {}),
            ...(flags.commit ? { commitSha: flags.commit } : {}),
            ...(flags.pr ? { pr: Number(flags.pr) } : {}),
          },
          await writeSession(),
        ),
      );
      out(n);
      if (!flags.json)
        console.log(
          `note #${n.id} added on ${n.path} (${n.base_sha}..${n.commit_sha})`,
        );
    } else if (sub === "list") {
      const notes = await run(() =>
        s.reviewNotes.list(repo, {
          ...(flags.pr ? { pr: Number(flags.pr) } : {}),
          ...(flags.path ? { path: flags.path } : {}),
          ...(flags.base ? { baseSha: flags.base } : {}),
          ...(flags.commit ? { commitSha: flags.commit } : {}),
        }),
      );
      out(notes);
      if (!flags.json)
        notes.forEach((n: any) => {
          console.log(
            `#${n.id}\t${n.path}\t${n.base_sha}..${n.commit_sha}\t${n.body}`,
          );
        });
    } else if (sub === "get") {
      const n = await run(() => s.reviewNotes.get(repo, Number(rest[0])));
      out(n);
      if (!flags.json)
        console.log(
          `#${n.id}\t${n.path}\t${n.base_sha}..${n.commit_sha}\t${n.body}`,
        );
    } else if (sub === "edit") {
      if (!flags.body) fail("--body is required");
      const n = await run(async () =>
        s.reviewNotes.update(
          repo,
          Number(rest[0]),
          flags.body as string,
          await writeSession(),
        ),
      );
      out(n);
      if (!flags.json) console.log(`note #${n.id} updated`);
    } else if (sub === "rm") {
      await run(async () =>
        s.reviewNotes.remove(repo, Number(rest[0]), await writeSession()),
      );
      console.log(`note #${rest[0]} deleted`);
    } else usage();
    return;
  }

  if (group === "handoff") {
    // Record / list orchestrator<->subagent handoffs (#352). A handoff binds to a PR (--pr, the
    // ref the design's `--ref <pr>` names) and/or a generic issue (--issue); the recording session
    // is the attribution session (--session-id), so the record hangs off "PR + session" naturally.
    const s = await svc();
    const repo = await resolveRepo();
    if (sub === "record") {
      const recordUsage =
        "usage: lh handoff record --phase <p> --dir <down|up> (--pr <n> | --issue <n>) (--body <text|-> | --src <ref> [--hash <sha>]) [--from <r>] [--to <r>] [--summary <text>] [--model <m>] [--cost <json>] [--repo owner/name]";
      if (!flags.phase || !flags.dir) fail(recordUsage);
      if (!flags.pr && !flags.issue)
        fail(`--pr or --issue is required\n${recordUsage}`);
      if (!flags.body && !flags.src)
        fail(`--body or --src is required\n${recordUsage}`);
      // `--body -` reads the instruction/report from stdin so large prompts aren't shell args.
      const body =
        flags.body === "-"
          ? await readStdin()
          : (flags.body as string | undefined);
      const session = await writeSession();
      const h = await run(() =>
        s.handoffs.record(
          repo,
          {
            phase: flags.phase as string,
            direction: flags.dir as string,
            pr: flags.pr ? Number(flags.pr) : undefined,
            issue: flags.issue ? Number(flags.issue) : undefined,
            from: flags.from,
            to: flags.to,
            body,
            src: flags.src,
            hash: flags.hash,
            summary: flags.summary,
            model: flags.model,
            cost: flags.cost,
          },
          session,
        ),
      );
      if (flags.json) out(h);
      else {
        const target = h.pull_request
          ? `PR #${h.pull_request.number}`
          : `issue #${h.issue?.number}`;
        console.log(
          `recorded handoff #${h.seq} (${h.phase}/${h.direction}) on ${target}${h.summary ? `: ${h.summary}` : ""}`,
        );
      }
    } else if (sub === "list") {
      const handoffs = await run(() =>
        s.handoffs.list(repo, {
          ...(flags.pr ? { pr: Number(flags.pr) } : {}),
          ...(flags.issue ? { issue: Number(flags.issue) } : {}),
          ...(flags.session ? { session: flags.session } : {}),
        }),
      );
      if (flags.json) out(handoffs);
      else
        handoffs.forEach((h: any) => {
          const ref = h.src ? `src=${h.src}` : "body";
          console.log(
            `#${h.seq}\t${h.phase}/${h.direction}\t${h.from ?? "?"}→${h.to ?? "?"}\t${ref}\t${h.summary ?? ""}`,
          );
        });
    } else usage();
    return;
  }

  if (group === "worktree") {
    if (sub !== "prune") {
      usage();
      return;
    }
    const s = await svc();
    const dryRun = flags["dry-run"] === true;
    const assumeYes = flags.yes === true;
    const repoFilter = flags.repo ?? null;

    // Scanning, issue/PR resolution and classification live in core (s.worktrees); the CLI only
    // presents, confirms, and reports.
    const entries = await run(() =>
      s.worktrees.plan({ repo: repoFilter, cwd: process.cwd() }),
    );
    const candidates = entries.filter((e) => e.action === "remove");
    const keep = entries.filter((e) => e.action === "keep");
    const skip = entries.filter((e) => e.action === "skip");

    if (flags.json) {
      out({ candidates, keep, skip, dryRun });
    } else {
      const fmt = (e: (typeof entries)[number]) =>
        `  ${e.repo}#${e.issue}\t${e.path}\t(${e.reason})`;
      console.log(`Remove candidates (${candidates.length}):`);
      for (const e of candidates) console.log(fmt(e));
      if (keep.length) {
        console.log(`\nKeep (${keep.length}):`);
        for (const e of keep) console.log(fmt(e));
      }
      if (skip.length) {
        console.log(`\nSkip (${skip.length}):`);
        for (const e of skip) console.log(fmt(e));
      }
    }

    if (dryRun) {
      if (!flags.json) console.log("\ndry-run: nothing removed.");
      return;
    }

    if (candidates.length === 0) {
      if (!flags.json) console.log("\nNothing to prune.");
      await s.worktrees.tidy(repoFilter); // still tidy stale admin entries
      return;
    }

    if (!assumeYes) {
      const ok = await confirm(`\nRemove ${candidates.length} worktree(s)?`);
      if (!ok) {
        if (!flags.json) console.log("aborted.");
        return;
      }
    }

    let removed = 0;
    for (const e of candidates) {
      const res = await s.worktrees.remove(e);
      if (res.removed) {
        removed++;
        if (!flags.json) console.log(`removed ${e.path}`);
      } else {
        console.error(`failed to remove ${e.path}: ${res.reason}`);
      }
    }

    await s.worktrees.tidy(repoFilter);
    if (!flags.json) console.log(`\nPruned ${removed} worktree(s).`);
    return;
  }

  if (group === "retro") {
    const s = await svc();
    const repo = await resolveRepo();
    if (sub === "create") {
      const usageLine =
        "usage: lh retro create --pr <m> --input <file|-> [--status draft]";
      if (!flags.pr) fail(usageLine);
      if (!flags.input) fail(`--input is required\n${usageLine}`);
      const raw =
        flags.input === "-"
          ? await readStdin()
          : readFileSync(flags.input, "utf8");
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        fail(
          "--input must be JSON: { rubric: [...], findings: [...], status? }",
        );
      }
      const retro = await run(async () =>
        s.retros.create(
          repo,
          {
            pr: Number(flags.pr),
            rubric: data.rubric,
            findings: data.findings,
            status: flags.status ?? data.status,
            redacted: data.redacted,
            redact_ruleset: data.redact_ruleset,
          },
          await writeSession(),
        ),
      );
      if (flags.json) out(retro);
      else
        console.log(
          `created retro #${retro.id} for PR #${retro.pr?.number} (${retro.status})`,
        );
    } else if (sub === "list") {
      const rows = await run(() =>
        s.retros.list(repo, {
          pr: flags.pr ? Number(flags.pr) : undefined,
          status: flags.status,
        }),
      );
      out(rows);
      if (!flags.json)
        rows.forEach((rt: any) => {
          const warn = rt.rubric.filter(
            (x: any) => x.severity === "warn",
          ).length;
          const bad = rt.rubric.filter((x: any) => x.severity === "bad").length;
          console.log(
            `#${rt.id}\tPR #${rt.pr?.number ?? "?"}\t${rt.status}\twarn:${warn} bad:${bad}\tfindings:${rt.findings.length}\t${relativeTime(rt.created_at)}`,
          );
        });
    } else if (sub === "view") {
      if (!rest[0]) fail("usage: lh retro view <id>");
      const rt = await run(() => s.retros.get(repo, Number(rest[0])));
      out(rt);
      if (!flags.json) {
        const lines: string[] = [];
        lines.push(
          `retro #${rt.id} [${rt.status}]  PR #${rt.pr?.number ?? "?"}${rt.pr ? ` ${rt.pr.title}` : ""}`,
        );
        if (rt.issue) lines.push(`linked issue #${rt.issue.number}`);
        lines.push(`session: ${rt.session_id ?? "(none)"}`);
        lines.push("");
        lines.push("Rubric:");
        for (const x of rt.rubric)
          lines.push(
            `  [${x.severity}] ${x.id} ${x.signal}=${x.value ?? ""}${x.note ? ` — ${x.note}` : ""}`,
          );
        lines.push("");
        lines.push("Findings:");
        for (const f of rt.findings)
          lines.push(
            `  [${f.severity}] (${f.category}) ${f.note}${f.evidence_ref ? ` <${f.evidence_ref}>` : ""}${f.proposed_action ? `\n    -> ${f.proposed_action}` : ""}`,
          );
        console.log(lines.join("\n"));
      }
    } else if (sub === "pending") {
      const items = await run(() =>
        s.retros.pending(repo, {
          limit: flags.limit ? Number(flags.limit) : undefined,
        }),
      );
      out(items);
      if (!flags.json)
        items.forEach((p: any) => {
          console.log(
            `#${p.number}\t${p.title}\tmerged ${p.merged_at ? relativeTime(p.merged_at) : "?"}`,
          );
        });
    } else usage();
    return;
  }

  if (group === "sync") {
    const s = await svc();
    const r = await s.sync.run();
    console.log(`updated ${r.updated} PR(s)`);
    return;
  }

  if (group === "events") {
    const s = await svc();
    const labels = (flags.label || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const printEvent = (e: {
      id: number;
      type: string;
      actor: string;
      payload: unknown;
    }) => {
      if (flags.json) console.log(JSON.stringify(e));
      else
        console.log(
          `${e.id}\t${e.type}\t${e.actor}\t${JSON.stringify(e.payload)}`,
        );
    };
    if (flags.follow) {
      // Stream the SSE feed continuously. Order is always chronological (a live tail can't
      // be reversed); --order applies only to the one-shot snapshot. --json emits one JSON
      // object per line (NDJSON) rather than the snapshot's single array.
      const controller = new AbortController();
      process.on("SIGINT", () => controller.abort()); // Ctrl-C: stop cleanly, exit 0
      try {
        await s.events.follow(
          { since: Number(flags.since || 0), repo: flags.repo || null, labels },
          printEvent,
          controller.signal,
        );
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      return;
    }
    const evs = s.events.list({
      since: Number(flags.since || 0),
      repo: flags.repo || null,
      labels,
      order: flags.order === "desc" ? "desc" : "asc",
    });
    if (flags.json) out(evs);
    else evs.forEach(printEvent);
    return;
  }

  usage();
}

function usage() {
  console.log(`lh — LoopHub CLI

  lh info [--json]                                 # resolved env: baseUrl (Web UI), home, dbPath
  lh dev <owner>/<repo>/<id> | <id> [--repo owner/name] [--sandbox [--allow d1,d2]] [--auto] [--verbose] [--kani] [--force]   # start one issue in an interactive Claude session (--auto: auto mode without the sandbox; --kani: in a new kani terminal; --force: launch even if another session holds it)
  lh dev note --kind <decision|action|assumption|blocker> --summary <text> [--body <text>] [--issue <n>] [--pr <n>] [--repo owner/name]   # record a dev note on the issue's PR
  lh resume <owner>/<repo>/<pr> | <pr> [--repo owner/name]   # re-enter the Claude session a PR was developed in (claude --resume in its worktree)
  lh repo add <path> [--name owner/repo]
  lh repo list [--archived false|true|all]
  lh repo archive <owner/repo>   lh repo unarchive <owner/repo>
  lh repo update --repo owner/name [--default-branch main] [--path /abs/path]
  lh repo remove --repo owner/name
  lh session register --id <uuid> --agent <kind> --session <runtime-id> [--name "..."] [--runtime claude-code] [--kind dev|review|issue-create]
  lh session list
  lh issue list|view|create|update|comment|close|label  [--repo owner/repo]
  lh pr list|view|diff|create|update|merge|review|ready-for-review|close|reopen  [--repo owner/repo]
  lh pr note <m> --path <file> --body <text> [--base <sha>] [--commit <sha>]   # add a review note for a file on the PR's diff (range defaults to base..head)
  lh pr notes <m> [--path <file>] [--commit <sha>]   lh pr note-edit <id> --body <text>   lh pr note-rm <id>   # list / edit / delete review notes
  lh note add --path <file> --body <text> --base <sha> --commit <sha> [--pr <m>]   # add a PR-independent review note for a file on a commit range
  lh note list [--pr <m>] [--path <file>] [--base <sha>] [--commit <sha>]   lh note get <id>   lh note edit <id> --body <text>   lh note rm <id>   # read / edit / delete review notes
  lh handoff record --phase <p> --dir <down|up> (--pr <m> | --issue <n>) (--body <text|-> | --src <ref> [--hash <sha>]) [--from <r>] [--to <r>] [--summary <text>] [--model <m>] [--cost <json>]   # record an orchestrator<->subagent handoff (PR + session)
  lh handoff list [--pr <m>] [--issue <n>] [--session <id>] [--json]   # list handoffs for a ref, chronological
  lh retro create --pr <m> --input <file|-> [--status draft]   # save a generated retrospective (rubric+findings) for a PR
  lh retro list [--pr <m>] [--status draft]   lh retro view <id>   lh retro pending [--limit N]   # read retros / list merged PRs without one
  lh worktree prune [--repo owner/name] [--dry-run] [--yes]   # GC done lh-dev worktrees (issue closed / PR merged, clean tree)
  lh attachment add --file <path> [--file <path> ...] [--actor name]   # upload image(s), print embed markdown
  lh sync                                          # detect open-PR head updates and emit events
  lh events [--since <id>] [--repo owner/repo] [--label name[,name]] [--order asc|desc] [--follow|-f]   # --follow: tail the SSE feed (replay matching, then live; Ctrl-C to stop). --order applies to the snapshot only (a live tail is always chronological)

  common: --session-id <uuid>  --json
  examples:
    lh dev 42
    lh dev jugyo/loophub/42        # owner/repo/id form: start from outside the repo, no --repo needed
    lh dev --sandbox 42            # boolean flags and the issue id may appear in any order
    lh dev --auto 42               # auto mode (--permission-mode auto) without the sandbox
    lh repo add . --name me/proj
    SID=$(uuidgen)
    lh session register --id "$SID" --agent impl-bot --session "$RUNTIME"
    lh issue create --title "do the thing" --label ready-to-build
    lh pr create --head feature-x --base main --title "impl" --issue 5 [--draft]
    lh pr merge 3 --method squash
    lh pr review 3 --event request_changes --body "please fix" --comments review.json
    lh pr review 3 --topic security --event approve --body "no issues found"
    echo '[{"path":"a.txt","line":2,"body":"typo"}]' | lh pr review 3 --comments -
    lh pr note 3 --path src/app.ts --body "entry point; added auth guard. review: token refresh path"
    lh attachment add --file shot.png        # prints ![shot.png](/attachments/<sha256>)
    lh events --since 0
    lh events --follow                 # tail events live (Ctrl-C to stop)
    lh events -f --repo me/proj --json # live NDJSON for one repo`);
  process.exit(group ? 1 : 0);
}

main();
