import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  agentModel,
  codingAgent,
  configDir,
  worktreeRoot,
} from "../../core/config.ts";
import { gitCommonDir, gitDirOf } from "../../core/git.ts";
import {
  LH_BUILD_SESSION_AGENT,
  RUNTIME_CLAUDE_CODE,
  RUNTIME_CODEX,
  resolveWorktreeIdentity,
} from "../../core/resume.ts";
import * as Store from "../../core/store.ts";
import {
  acquireHerdrWorktreeTab,
  buildHerdrLaunchPlan,
  type HerdrCmdRunner,
  herdrCommandLine,
  herdrPaneCloseArgv,
  herdrTabCloseArgv,
  herdrTabCreateArgv,
  herdrTabFocusArgv,
  herdrWorkspaceCloseArgv,
  herdrWorkspaceFocusArgv,
  parseHerdrRootPaneId,
  parseHerdrTabId,
} from "../../core/terminal/terminal-launch.ts";
import { flags, sub } from "../args.ts";
import { display, fail, resolveRepo, run as runOp, svc } from "../context.ts";
import {
  acquireDevLock,
  buildManagedSettings,
  buildRuntimeLaunch,
  type DevRuntime,
  devLockPath,
  displayMultiline,
  formatLaunchPlan,
  formatLaunchSummary,
  formatSpawnCommand,
  legacyWorktreePath,
  parseDevTarget,
  pidAlive,
  provisionWorktree,
  removeDevLock,
  resolveAllowedDomains,
  resolveDevRuntime,
  validateExistingLocalBranch,
  validateRepo,
  worktreePath,
} from "../dev.ts";

export async function run(): Promise<void> {
  const target = sub;
  const usageLine =
    "usage: lh build <owner>/<repo>/<id> | <id> [--repo owner/name] [--new-attempt] [--claude-code | --codex] [--model <name>] [--sandbox [--allow d1,d2]] [--auto] [--verbose] [--herdr] [--force]";
  if (!target) {
    fail(usageLine);
  }
  // Parse the positional: bare <id> defers repo resolution to resolveRepo(); the
  // <owner>/<repo>/<id> form carries the repo so `lh build` can run from outside that repo.
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
  const newAttempt = flags["new-attempt"] === true;
  const sessionId = randomUUID();
  const slashCommand = `/lh-build ${issue}`;

  // Resolve the agent runtime (#458): Claude Code by default, Codex with --codex, or the
  // configured `codingAgent` app setting (#516) when neither flag is passed. Passing both
  // flags is ambiguous and fails before any side effect.
  let runtime: DevRuntime;
  try {
    runtime = resolveDevRuntime({
      claudeCode: flags["claude-code"] === true,
      codex: flags.codex === true,
      defaultRuntime: codingAgent(),
    });
  } catch (e: any) {
    fail(`${e.message}\n${usageLine}`);
  }

  // Validate --allow vs --sandbox flag early.
  const useSandbox = flags.sandbox === true;
  if (flags.allow && !useSandbox) {
    fail("--allow can only be used with --sandbox");
  }

  // With strict:false, a value-less `--model` parses as boolean true (see the Flags comment on
  // `archived`) — fail with a usage error up front rather than crashing later in the argv
  // builders (shQuote / spawnSync require a string), after side effects like opening the PR.
  if (flags.model !== undefined && typeof flags.model !== "string") {
    fail(`--model requires a value\n${usageLine}`);
  }

  // The sandbox managed-settings are a `claude` launch option with no Codex equivalent —
  // reject the combination up front rather than silently dropping the flags. --auto and
  // --model both have Codex equivalents (#499, #594; see buildCodexArgs) so they're allowed
  // with --codex.
  if (runtime === "codex" && useSandbox) {
    fail(
      "--sandbox/--allow are only supported with the claude-code runtime (remove them or drop --codex)",
    );
  }

  // Resolve the session model: an explicit --model wins; otherwise fall back to the
  // configured per-agent default (claude-code -> opus, codex -> gpt-5.5 unless overridden via
  // Settings, #594).
  const model =
    typeof flags.model === "string" && flags.model.trim()
      ? flags.model
      : agentModel(runtime);

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
  const r = await runOp(() => s.repos.get(repo));
  const item = await runOp(() => s.issues.get(repo, n));
  if (item.pull_request && newAttempt) {
    fail("--new-attempt requires an issue, not a pull request");
  }

  // Make the work visible: register this session before anything that links to it (session_links
  // has a FK on agent_sessions, so dev.openPr below — which links the session to the PR it opens
  // — must run after this). The runtime session id is the Claude session we are about to spawn
  // (unique per run, so re-launching the same issue never collides on the (agent, session) pair).
  await runOp(() =>
    s.sessions.register({
      id: sessionId,
      agent: LH_BUILD_SESSION_AGENT,
      session: sessionId,
      // Record which runtime the session we are about to spawn runs in, so `lh resume` picks
      // the resume command by runtime rather than inferring it from the agent. Codex sessions
      // are recorded too, but `lh resume` cannot re-enter them yet (see RUNTIME_CODEX).
      runtime: runtime === "codex" ? RUNTIME_CODEX : RUNTIME_CLAUDE_CODE,
      // This is an implementation (dev) session; record its kind (#298) so it surfaces in the
      // PR's related-sessions list as a dev session. (setPullSession also stamps 'dev' when it
      // attributes the session to the PR — this just sets it at the registration point too.)
      kind: "dev",
    }),
  );

  // Resolve the PR this session is developing *before* provisioning the worktree (#463): the
  // worktree path/branch are now PR-id-based, so the PR must exist first. A PR target already
  // has one; an issue target opens (or reuses) its draft PR here so the agent has a place to
  // write its plan — that call is NOT best-effort: without a PR number there is
  // nothing to provision a worktree for, so a failure here aborts the launch. The session row
  // registered above is left in place on that abort (a harmless orphan — it is never linked to
  // a PR and a fresh randomUUID means the next launch can't collide with it).
  //
  // Attributing *this* session to the PR (session_links) is deferred until after the dev lock
  // is claimed below (see the attachSession call there): the lock is keyed by PR number, which
  // isn't known until this resolves, so a losing concurrent `lh build` racing on the same
  // already-open PR must not be allowed to re-point its session pointer before the lock
  // differentiates winner from loser — otherwise the winner's live session could be silently
  // orphaned from session_links and `lh resume` would resolve the loser's dead one instead.
  let prNumber: number;
  let prJustOpened: { created: boolean } | null = null;
  if (item.pull_request) {
    prNumber = item.number;
  } else {
    // Note: the dev lock below is keyed by PR number, which is not known until openPr resolves
    // it — so, unlike before #463, two concurrent `lh build <same-issue>` runs racing to reach
    // this call are not serialized by the lock (dev.openPr's own "one open PR per issue" guard
    // is a soft, non-transactional check-then-act — see core/service.ts pulls.create). Adding
    // issue-level concurrency control for this is explicitly out of scope for #463 (see the
    // issue's "Out of scope" section); a second concurrent launch on a brand-new issue can in
    // the worst case create two draft PRs for it.
    try {
      const res = await s.dev.openPr(repo, { issue: n }, sessionId, {
        attributeSession: false,
        parallel: newAttempt,
      });
      prNumber = res.number;
      prJustOpened = res;
    } catch (e: any) {
      fail(`could not open draft PR: ${e.message}`);
    }
  }
  const rawPullIssue = Store.getIssue(r.id, prNumber);
  const rawPull = rawPullIssue ? Store.getPull(rawPullIssue.id) : null;
  if (rawPullIssue?.kind !== "pull" || !rawPull) {
    fail(`pull request #${prNumber} not found`);
  }
  const headRef: string = rawPull.head_ref;
  const baseRef: string = rawPull.base_ref;
  try {
    await validateExistingLocalBranch(r.local_path, baseRef, "PR base ref");
  } catch (e: any) {
    fail(e.message);
  }

  // The naming scheme for this PR's worktree: the current PR-id convention (#463), or — for a
  // PR whose worktree was already provisioned before this change — the legacy issue-id
  // convention, still recognized so it is not orphaned.
  const identity = resolveWorktreeIdentity(headRef, prNumber);

  // Duplicate-launch guard: atomically claim this PR's worktree before any side effect
  // (provisioning). The worktree path/branch are deterministic from the PR (#463 — previously
  // the issue), so a second concurrent `lh build` targeting the same PR would share the same tree
  // and clobber edits; two PRs linked to the same issue no longer collide. acquireDevLock
  // exclusively creates the lock recording this process's pid; if a *live* `lh build` already
  // holds it we refuse (unless --force). A stale lock (the previous session crashed / was
  // interrupted, so its pid is gone) is reclaimed, so a finished session never blocks a
  // relaunch. Host-local by design (cross-host exclusion is out of scope). The exit handler is
  // registered immediately so the lock is released even if provisioning below fails.
  const lockPath = devLockPath(configDir(), r.full_name, prNumber);
  const wtPath =
    identity.scheme === "legacy-issue"
      ? legacyWorktreePath(worktreeRoot(), r.full_name, identity.number)
      : worktreePath(worktreeRoot(), r.full_name, identity.number);
  const claim = acquireDevLock(
    lockPath,
    {
      pid: process.pid,
      pr: prNumber,
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
      `PR #${prNumber} is already being worked on by another \`lh build\` session ` +
        `(pid ${l.pid}, since ${l.startedAt}).\n` +
        `  worktree: ${wtPath}\n` +
        `Launching a second session would share this worktree and clobber edits. ` +
        `Wait for that session to finish, or pass --force to launch anyway.`,
    );
  }
  process.on("exit", () => removeDevLock(lockPath));

  // Now that this launch has won the dev lock, it is safe to point the PR's session pointer
  // (session_links) at this session — no other concurrent `lh build` can still be racing to do
  // the same for this PR (see the note above). Idempotent and best-effort: a failure only
  // warns, since the PR itself is already resolved and the worktree can still be provisioned.
  try {
    await s.dev.attachSession(repo, prNumber, sessionId);
  } catch (e: any) {
    console.error(`warning: could not attach session to PR: ${e.message}`);
  }

  let worktree: string;
  try {
    worktree = await provisionWorktree({
      repoPath: r.local_path,
      fullName: r.full_name,
      defaultBranch: baseRef,
      worktreeRoot: worktreeRoot(),
      pr: identity.number,
      scheme: identity.scheme,
      headRef,
      // Only a PR `dev.openPr` genuinely just created THIS run may have its convention branch
      // fabricated fresh if missing — that branch is guaranteed to have never existed in git
      // yet. Gating on "issue target" alone is not enough: re-running `lh build <issue>` against
      // an already-existing (reused, not just-created) PR reaches this same code path, and its
      // convention branch missing there would mean it was deleted out-of-band — silently
      // fabricating a fresh one would discard whatever history it held, same risk as a direct
      // PR target. `created` is only true for a brand-new PR, so this correctly refuses in both
      // the direct-PR-target and reused-PR cases.
      allowCreatingConventionBranch: prJustOpened?.created === true,
      baseSha: rawPull.base_sha ?? undefined,
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

  // Report the PR resolved above, now that the launch header (verbose issue dump or the plain
  // `#n title` line) has printed.
  if (!item.pull_request) {
    console.error(
      prJustOpened?.created
        ? `draft PR #${prNumber} opened`
        : `using existing PR #${prNumber}`,
    );
  }

  // Build the sandbox managed-settings only when --sandbox is enabled.
  // When sandbox is disabled (default), managed will be undefined.
  let managed: string | undefined;
  if (useSandbox) {
    try {
      const [gitDir, worktreeGitDir] = await Promise.all([
        gitCommonDir(worktree),
        gitDirOf(worktree),
      ]);
      ({ json: managed } = buildManagedSettings({
        repo,
        allow: flags.allow,
        git: { gitDir, worktreeGitDir, branch: headRef },
      }));
    } catch (e: any) {
      fail(e.message);
    }
  }

  // Set the session display name to the PR being worked on so the session picker / terminal title
  // shows the linked PR (#336). buildClaudeArgs strips control chars from the title before argv.
  const sessionName = `#${prNumber} ${item.title}`;
  // The argv for the selected runtime (#458). Codex takes only the initial prompt (the same
  // `/lh-build <id>` slash command, run from the same worktree cwd); claude additionally carries
  // the session id / display name / sandbox settings, which have no Codex equivalent.
  const { bin: runtimeBin, args: runtimeArgs } = buildRuntimeLaunch({
    runtime,
    sessionId,
    managedSettings: managed,
    // --auto enables auto mode without the sandbox; --sandbox already implies it via managed.
    auto: flags.auto === true,
    slashCommand,
    sessionName,
    // The resolved session model (explicit --model, else the per-agent default, #486, #594).
    model,
  });

  // Show what the runtime will receive, then launch immediately (no confirmation prompt). By
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
        claudeArgs: runtimeArgs,
      }),
    );
  } else {
    console.error(
      formatLaunchSummary({
        repo,
        worktree,
        branch: headRef,
        sessionId,
      }),
    );
  }
  // Always show the exact command being spawned as the last line of the launch output, in
  // dim/gray, so a normal launch (no --verbose) still reveals and lets you copy what runs.
  // This supersedes the old --verbose-only `exec:` line — unified into one always-on display.
  // Built from `runtimeArgs` (the same argv handed to spawnSync below) for an exact match.
  console.error(
    formatSpawnCommand(runtimeArgs, {
      color: process.stderr.isTTY === true,
      bin: runtimeBin,
    }),
  );

  // --herdr: the worktree/PR setup above already ran in this process; hand the interactive
  // runtime off to a herdr pane instead of blocking this process's own foreground with it —
  // mirrors the removed --kani flag, but launches *after* setup completes here rather than
  // relaunching itself first (#584), so there is no inner/outer recursion to avoid. This is
  // also how the Build button's herdr launch works now: it just spawns `lh build <id> --herdr`
  // and lets this branch do the rest (core/service.ts's launchIssueDevHerdr).
  if (flags.herdr === true) {
    const repoRef = { full_name: r.full_name, local_path: r.local_path };
    const command = formatSpawnCommand(runtimeArgs, { bin: runtimeBin });
    // Best-effort herdr runner for the ancillary tab/workspace calls (open, create, focus,
    // close) below. spawnSync suits this short-lived CLI process (unlike lh-web, whose single
    // server process spawns herdr async); all-ignore stdio keeps herdr's own JSON/errors out of
    // the launch output, and it never throws — a failed call resolves ok:false so
    // acquireHerdrWorktreeTab / the fallback simply degrade.
    const runHerdrCmd: HerdrCmdRunner = async (argv, opts) => {
      const proc = spawnSync(argv[0], argv.slice(1), {
        stdio: opts?.captureStdout ? ["ignore", "pipe", "ignore"] : "ignore",
        timeout: 15_000,
        encoding: "utf8",
      });
      const ok = !proc.error && proc.signal == null && (proc.status ?? 0) === 0;
      return {
        stdout: ok && opts?.captureStdout ? (proc.stdout ?? "") : "",
        ok,
      };
    };
    // Open (or reuse) the worktree's own herdr workspace and start the agent in a fresh tab
    // there, instead of splitting whatever pane is currently focused (#674) — the same thing
    // lh-web's terminal.launch does for the other worktree-backed workflows. Falls back to a
    // plain repo-root tab (still a new tab, not a split) when the worktree open can't be
    // resolved (herdr not running, worktree_not_found, …).
    let tabId: string | null = null;
    let rootPaneId: string | null = null;
    // The fresh single-tab workspace this launch *owns* (cleanup target on failure) — set only when
    // acquireHerdrWorktreeTab created one, null for a reused workspace.
    let workspaceId: string | null = null;
    // The target worktree's workspace, used as the `--workspace` placement fallback when tabId came
    // back null (#873). Set whether the workspace was freshly opened or reused; only ever absent on
    // the plain repo-root tab-create fallback below (which has no worktree workspace at all).
    let placementWorkspaceId: string | null = null;
    let createdWorkspace = false;
    const acquired = await acquireHerdrWorktreeTab(
      repoRef,
      worktree,
      runHerdrCmd,
    );
    if (acquired) {
      ({ tabId, rootPaneId, workspaceId, createdWorkspace } = acquired);
      placementWorkspaceId = acquired.targetWorkspaceId;
    } else {
      const out = await runHerdrCmd(herdrTabCreateArgv(repoRef), {
        captureStdout: true,
      });
      if (out.ok) {
        tabId = parseHerdrTabId(out.stdout);
        rootPaneId = parseHerdrRootPaneId(out.stdout);
        // A zero-exit create with no parseable tab id means herdr made a real tab but its output
        // shape drifted: tabId stays null, and with no worktree workspace to fall back to (this is
        // the plain repo-root path) the agent splits the focused pane and the new tab is orphaned
        // with no id to close it. Surface it (mirrors launchIssueDevHerdr's server-side warning) so
        // the drift is noticed instead of leaking silently.
        if (!tabId)
          console.error(
            "herdr tab create succeeded but its output had no usable tab id; falling back to split placement",
          );
      }
    }
    // The pane is pinned to the worktree (not repo.local_path) but keeps the repo's herdr
    // session name, so it lands alongside every other launch for this repo (Build button,
    // resume, …) in the same `herdr session attach`. When tabId failed to parse but the worktree's
    // workspace was opened/reused, `--workspace placementWorkspaceId` keeps the agent inside that
    // workspace instead of splitting whatever (possibly unrelated) pane is focused (#873).
    const plan = buildHerdrLaunchPlan({
      repo: repoRef,
      command,
      label: sessionName,
      tabId,
      workspaceId: placementWorkspaceId,
      cwd: worktree,
    });
    const herdrProc = spawnSync(plan.argv[0], plan.argv.slice(1), {
      stdio: "inherit",
      timeout: 15_000,
    });
    // Any failure to start the agent leaves the just-created tab (or workspace) empty — clean it
    // up before failing. herdr refuses to close a workspace's last tab, so a workspace this
    // launch created is closed wholesale. The reproduce hint is built from a *tab-less* plan:
    // the failed argv's `--tab <id>` points at the tab just cleaned up, so re-running it verbatim
    // would fail with an unknown-tab error instead of reproducing the original failure.
    const cleanupOnFailure = async () => {
      if (workspaceId)
        await runHerdrCmd(herdrWorkspaceCloseArgv(repoRef, workspaceId));
      else if (tabId) await runHerdrCmd(herdrTabCloseArgv(repoRef, tabId));
    };
    const reproduce = () =>
      herdrCommandLine(
        buildHerdrLaunchPlan({
          repo: repoRef,
          command,
          label: sessionName,
          cwd: worktree,
        }),
      );
    if (herdrProc.error) {
      const err = herdrProc.error as NodeJS.ErrnoException;
      await cleanupOnFailure();
      if (err.code === "ENOENT") {
        fail("failed to launch herdr: 'herdr' not found on PATH");
      }
      fail(`failed to launch herdr: ${err.message}`);
    }
    // spawnSync's own `timeout` kills the child via signal without populating `.error`, so
    // `status` comes back `null` on both a timeout and an external kill — checking status alone
    // would silently report either as success.
    if (herdrProc.signal) {
      await cleanupOnFailure();
      fail(
        `herdr was terminated by signal ${herdrProc.signal} (killed, or timed out after 15s)\n  reproduce: ${reproduce()}`,
      );
    }
    if ((herdrProc.status ?? 0) !== 0) {
      await cleanupOnFailure();
      fail(
        `herdr exited with status ${herdrProc.status}\n  reproduce: ${reproduce()}`,
      );
    }
    // Bring the new agent's tab/workspace to the front (every call above used --no-focus so
    // creation wouldn't yank focus mid-launch) and close the tab's leftover empty seed pane —
    // best-effort, since the agent is already running: a focus/close failure must not fail the
    // launch, only leave one harmless empty pane behind.
    if (createdWorkspace && workspaceId) {
      await runHerdrCmd(herdrWorkspaceFocusArgv(repoRef, workspaceId));
    } else if (tabId) {
      await runHerdrCmd(herdrTabFocusArgv(repoRef, tabId));
    } else if (placementWorkspaceId) {
      // Reused workspace whose new tab id failed to parse: the agent launched via
      // `--workspace placementWorkspaceId`, so bring that workspace forward (#873).
      await runHerdrCmd(herdrWorkspaceFocusArgv(repoRef, placementWorkspaceId));
    }
    if (tabId && rootPaneId) {
      await runHerdrCmd(herdrPaneCloseArgv(repoRef, rootPaneId));
    }
    console.error(
      `Launched in herdr session ${plan.sessionName}. Attach with: herdr session attach ${plan.sessionName}`,
    );
    process.exit(0);
  }

  // The lock claimed above holds our pid for the session's lifetime (the spawnSync below blocks
  // until the runtime exits); the exit handler releases it. Release is best-effort — if the
  // process is killed before it runs, the stale lock self-heals (its pid is gone, so the next
  // launch reclaims it).
  const proc = spawnSync(runtimeBin, runtimeArgs, {
    stdio: "inherit",
    cwd: worktree,
  });
  if (proc.error) {
    const err = proc.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      fail(`failed to launch ${runtimeBin}: '${runtimeBin}' not found on PATH`);
    }
    fail(`failed to launch ${runtimeBin}: ${err.message}`);
  }
  process.exit(proc.status ?? 0);
}
