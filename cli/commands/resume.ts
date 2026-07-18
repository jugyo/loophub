import { spawnSync } from "node:child_process";
import { worktreeRoot } from "../../core/config.ts";
import { RUNTIME_CLAUDE_CODE } from "../../core/resume.ts";
import { flags, sub } from "../args.ts";
import { fail, resolveRepo, run as runOp, svc } from "../context.ts";
import {
  buildResumeArgs,
  formatSpawnCommand,
  parseDevTarget,
  provisionWorktree,
  reconcileTargetRepo,
  validateRepo,
} from "../dev.ts";

export async function run(): Promise<void> {
  // `lh resume --session <id>` re-enters a session by its id (#299), for sessions with no PR/dev
  // worktree — chiefly the `issue-create` session `lh issue new` records. No worktree to restore:
  // resolve the runtime + id and spawn `claude --resume <id>` in the repo root. The issue detail's
  // related-sessions Resume button runs exactly this. Checked before the PR-positional path below.
  if (flags.session) {
    const sessionId = flags.session;
    const s = await svc();
    const resolution = await runOp(() => s.resume.resolveSession(sessionId));
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
      const r = await runOp(() => s.repos.get(repoArg));
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
  // the dev-session spawn (inherited env carries the NODE_OPTIONS conventions; cwd = worktree).
  const target = sub;
  const usageLine =
    "usage: lh resume <owner>/<repo>/<pr> | <pr> [--repo owner/name]";
  if (!target) fail(usageLine);
  // The positional accepts the same forms as the other target-taking commands (parseDevTarget):
  // a bare <pr> (repo from --repo/cwd) or <owner>/<repo>/<pr> (carries the repo so resume can run
  // from outside the checkout).
  let parsed: { repo?: string; id: number };
  try {
    parsed = parseDevTarget(target);
  } catch (e: any) {
    fail(`${e.message}\n${usageLine}`);
  }
  let targetRepo: string | undefined;
  try {
    targetRepo = reconcileTargetRepo(parsed.repo, flags.repo);
  } catch (e: any) {
    fail(e.message);
  }
  const repo = targetRepo ?? (await resolveRepo());
  const prNumber = parsed.id;
  try {
    validateRepo(repo);
  } catch (e: any) {
    fail(e.message);
  }

  const s = await svc();
  const r = await runOp(() => s.repos.get(repo));
  const resolution = await runOp(() => s.resume.resolve(repo, prNumber));
  if (!resolution.ok) {
    if (resolution.reason === "no-session") {
      fail(
        `PR #${prNumber}: no Claude session is recorded for this PR, so there is nothing to ` +
          `resume.\n(A resumable session id is saved when a development session starts, e.g. via Workflow.)`,
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
  // branch (same provisionWorktree path used to restore a removed-but-branch-present worktree).
  // allowCreatingConventionBranch is left at its default (false): decideResume already refused
  // "unrestorable" (worktree and branch both gone) above, so provisionWorktree never needs to
  // fabricate a branch here — it only ever reattaches an existing worktree or branch.
  let worktree: string;
  try {
    worktree = await provisionWorktree({
      repoPath: r.local_path,
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      worktreeRoot: worktreeRoot(),
      pr: resolution.worktreeNumber,
      scheme: resolution.worktreeScheme,
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
