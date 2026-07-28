import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { branchExists, revParse, worktreeAdd, worktreeList } from "./git.ts";
import type { WorktreeScheme } from "./resume.ts";
import {
  legacyWorktreeBranch,
  legacyWorktreePath,
  worktreeBranch,
  worktreePath,
} from "./worktree-path.ts";

// Provisions the on-disk git worktree for a PR's (or, under scheme "legacy-issue", an issue's)
// dev loop. Originally `cli/dev.ts`-only; lives in core so Workflow / herdr launchers
// (terminal.launch) and resume can provision a worktree without going through a removed CLI
// command — see `core/terminal/terminal-launch.ts` / the herdr worktree-open flow.

// Resolve symlinks when the path exists; fall back to lexical normalization otherwise.
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export interface ProvisionInput {
  repoPath: string; // primary checkout (shared .git)
  fullName: string; // owner/name
  defaultBranch: string;
  worktreeRoot: string;
  pr: number; // identity number for the worktree path/branch (PR number, or issue number under scheme "legacy-issue")
  scheme?: WorktreeScheme; // naming convention to use for path/branch; default "pr" (#463)
  headRef: string | null; // an explicit branch to check out; null => use the scheme's convention branch
  // Allow fabricating the scheme's convention branch fresh off the default branch when headRef is
  // given and matches that convention but the branch doesn't exist. True only when a launcher
  // itself just opened this PR this run (its branch genuinely never existed yet, #463); false
  // (default) for re-entering an already-established PR, where a missing convention branch means
  // it was deleted out-of-band and silently recreating it under the same name would discard
  // history without warning. Callers may also allow a pre-created attempt whose branch has
  // never existed (and therefore has no recorded head SHA). Ignored when headRef is null — that
  // path (a brand-new self-managed branch) has always been safe to create.
  allowCreatingConventionBranch?: boolean;
  // Optional immutable fork point for a newly created convention branch. Parallel attempts use
  // the first attempt's recorded base SHA so an advanced default branch cannot skew comparison.
  baseSha?: string;
}

// A conventional PR branch may be absent because Workflow (or another launcher) pre-created the
// attempt before its first worktree. That intent is durable on the pull row and is cleared together
// with the first provisioned SHA. Legacy/established rows stay strict; nullable watcher metadata is
// deliberately not used as lifecycle provenance.
export function shouldCreateMissingConventionBranch(input: {
  issueAttempt: { created: boolean } | null;
  headPendingCreation: boolean;
  baseSha: string | null;
}): boolean {
  return (
    input.issueAttempt !== null &&
    input.headPendingCreation &&
    input.baseSha !== null
  );
}

const CLAUDE_SETTINGS_FILES = ["settings.json", "settings.local.json"] as const;

// Claude project/local settings are usually untracked / gitignored, so a worktree built from the
// committed tree lacks them. Copy only the settings files a launched Claude session needs; other
// `.claude/` content can include large nested worktrees and must not be traversed. Run on every
// provision (including reuse) so existing source files stay current, and skip absent files.
function syncClaudeDir(repoPath: string, worktreePath: string): void {
  const sourceDir = join(repoPath, ".claude");
  const destinationDir = join(worktreePath, ".claude");
  for (const filename of CLAUDE_SETTINGS_FILES) {
    const source = join(sourceDir, filename);
    if (!existsSync(source)) continue;
    mkdirSync(destinationDir, { recursive: true });
    copyFileSync(source, join(destinationDir, filename));
  }
}

// Ensure a worktree for the PR (or, under scheme "legacy-issue", the issue) exists and return its
// path. Idempotent: an existing worktree at the deterministic path is reused as-is.
export async function provisionWorktree(
  input: ProvisionInput,
): Promise<string> {
  const { repoPath, fullName, defaultBranch, worktreeRoot, pr, headRef } =
    input;
  const scheme = input.scheme ?? "pr";
  const path =
    scheme === "legacy-issue"
      ? legacyWorktreePath(worktreeRoot, fullName, pr)
      : worktreePath(worktreeRoot, fullName, pr);
  const conventionBranch =
    scheme === "legacy-issue" ? legacyWorktreeBranch(pr) : worktreeBranch(pr);
  // The branch to check out: an explicit headRef wins (a PR target's actual head, which may or
  // may not exist yet — see below); otherwise the scheme's own convention branch.
  const branch = headRef ?? conventionBranch;

  // Reuse from disk truth: a registered worktree already at this path wins. `git worktree
  // list` canonicalizes paths (e.g. /var → /private/var on macOS), so compare real paths.
  const existing = await worktreeList(repoPath);
  const provisioned = existing.some(
    (w) => canonical(w.path) === canonical(path),
  );

  // A launcher-managed PR with no recorded head is only a resumable partial provision while its
  // conventional branch/worktree still points at the recorded fork point. A deleted PR may leave
  // both behind; if its number were reused, accepting a different HEAD here would silently turn
  // stale commits into the new attempt's implementation.
  if (input.allowCreatingConventionBranch && input.baseSha) {
    const existingHead = provisioned
      ? await revParse(path, "HEAD")
      : await revParse(repoPath, branch);
    if (existingHead && existingHead !== input.baseSha) {
      throw new Error(
        `cannot reuse pending PR ${scheme} branch/worktree: HEAD ${existingHead} does not match recorded base ${input.baseSha}`,
      );
    }
  }

  if (!provisioned) {
    // Path occupied but not a git worktree → refuse to silently overwrite.
    if (existsSync(path)) {
      throw new Error(
        `worktree path exists but is not a git worktree: ${path}`,
      );
    }

    mkdirSync(dirname(path), { recursive: true });

    if (await branchExists(repoPath, branch)) {
      // Branch already exists (a resumed PR, or a re-run after a prior partial provision) →
      // re-attach without -b.
      await worktreeAdd(repoPath, path, branch, defaultBranch, {
        existingBranch: true,
      });
    } else if (headRef && headRef !== conventionBranch) {
      // The caller expects a specific existing branch (e.g. a PR opened outside LoopHub's own
      // naming convention) that isn't ours to fabricate — its absence is a real error, not
      // something to paper over with a fresh branch under a different name.
      throw new Error(`branch "${headRef}" does not exist`);
    } else if (headRef && !input.allowCreatingConventionBranch) {
      // headRef matches our own convention branch, but it's missing and the caller has not
      // asserted this is a brand-new PR whose branch never existed — refuse rather than silently
      // fabricate a fresh, empty branch under the same name, which would look like "continuing
      // existing work" while actually discarding whatever history that branch held.
      throw new Error(
        `branch "${headRef}" does not exist (it should already exist for this PR)`,
      );
    } else {
      // Our own convention branch, not created yet (e.g. Workflow just opened this PR, #463) —
      // create it from the recorded fork point when supplied, otherwise the local default branch's
      // current commit (no fetch).
      const startPoint = input.baseSha ?? defaultBranch;
      if (
        input.baseSha
          ? !(await revParse(repoPath, input.baseSha))
          : !(await branchExists(repoPath, defaultBranch))
      ) {
        throw new Error(
          input.baseSha
            ? `cannot resolve base commit "${input.baseSha}"`
            : `cannot resolve default branch "${defaultBranch}" (no commits?)`,
        );
      }
      await worktreeAdd(repoPath, path, branch, startPoint);
    }
  }

  // Sync on every provision so reused worktrees pick up the latest settings too.
  syncClaudeDir(repoPath, path);
  return path;
}
