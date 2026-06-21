import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { branchExists, worktreeAdd, worktreeList } from "../core/git.ts";

// `lh dev` provisions an isolated git worktree (outside the sandbox) and launches an
// interactive Claude session in it. Everything here is pure CLI-side policy — it imports
// git plumbing from core but no DB — so it can be unit-tested and later moved to a
// swappable same-repo runner without touching core.

// ---- sandbox managed-settings ----
//
// Domains from --repo/--allow are validated and JSON-serialized here (never
// string-concatenated) so a value can never inject a sandbox key.
export const SANDBOX_DEFAULT_ALLOWED_DOMAINS = ["api.anthropic.com", "github.com"];

// A DNS label plus an optional single leading `*.` wildcard. No bare `*`, no quotes/spaces.
const DEV_DOMAIN_RE = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

export function validateDomain(raw: string): string {
  const d = raw.trim().toLowerCase();
  if (!d || d.length > 253 || !DEV_DOMAIN_RE.test(d)) {
    throw new Error(`invalid --allow domain "${raw}" (expected hostname or *.hostname)`);
  }
  return d;
}

export function buildManagedSettings({ repo, allow }: { repo: string; allow?: string }): {
  json: string;
  allowedDomains: string[];
} {
  if (repo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`invalid --repo "${repo}" (expected owner/name)`);
  }
  const extra = (allow ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(validateDomain);
  const allowedDomains = [...new Set([...SANDBOX_DEFAULT_ALLOWED_DOMAINS, ...extra])];
  const json = JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ["gh *"],
      filesystem: {
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc", "~/.config/gh", "~/.kube", "~/.docker/config.json"],
      },
      network: { allowedDomains, allowManagedDomainsOnly: true },
    },
    permissions: { defaultMode: "acceptEdits" },
  });
  return { json, allowedDomains };
}

// ---- interactive launch args ----
//
// Build the `claude` argv for the interactive dev session. Start already in accept-edits
// mode: the managed-settings `defaultMode: acceptEdits` does not drive the live interactive
// permission mode, so `--permission-mode acceptEdits` must be passed explicitly. Centralized
// here so the verbose `exec:` line and the real spawn share one source of truth.
export function buildClaudeArgs({
  sessionId,
  managedSettings,
  slashCommand,
}: {
  sessionId: string;
  managedSettings: string;
  slashCommand: string;
}): string[] {
  return [
    "--session-id",
    sessionId,
    "--permission-mode",
    "acceptEdits",
    "--managed-settings",
    managedSettings,
    slashCommand,
  ];
}

// ---- worktree provisioning ----
//
// Path and branch are deterministic from the issue number (no slug). Reuse is derived from
// disk truth (`git worktree list` + naming convention) — there is no ledger table.

// Resolve symlinks when the path exists; fall back to lexical normalization otherwise.
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function worktreeBranch(issue: number): string {
  return `loophub/issue-${issue}`;
}

// <worktreeRoot>/<owner>/<repo>/issue-<n>. fullName is the repo's "owner/name".
// Guard every segment so a crafted repo name can't traverse out of worktreeRoot.
export function worktreePath(worktreeRoot: string, fullName: string, issue: number): string {
  for (const seg of fullName.split("/")) {
    if (!seg || seg === "." || seg === ".." || seg.includes("\\")) {
      throw new Error(`invalid repo name for worktree path: "${fullName}"`);
    }
  }
  return join(worktreeRoot, fullName, `issue-${issue}`);
}

export interface ProvisionInput {
  repoPath: string; // primary checkout (shared .git)
  fullName: string; // owner/name
  defaultBranch: string;
  worktreeRoot: string;
  issue: number;
  headRef: string | null; // non-null => kind=pull; check out this existing branch
}

// Ensure a worktree for the issue exists and return its path. Idempotent: an existing
// worktree at the deterministic path is reused as-is.
export async function provisionWorktree(input: ProvisionInput): Promise<string> {
  const { repoPath, fullName, defaultBranch, worktreeRoot, issue, headRef } = input;
  const path = worktreePath(worktreeRoot, fullName, issue);

  // Reuse from disk truth: a registered worktree already at this path wins. `git worktree
  // list` canonicalizes paths (e.g. /var → /private/var on macOS), so compare real paths.
  const existing = await worktreeList(repoPath);
  if (existing.some((w) => canonical(w.path) === canonical(path))) return path;

  // Path occupied but not a git worktree → refuse to silently overwrite.
  if (existsSync(path)) {
    throw new Error(`worktree path exists but is not a git worktree: ${path}`);
  }

  mkdirSync(dirname(path), { recursive: true });

  if (headRef) {
    // PR (kind=pull): no new branch — check out the existing head branch.
    await worktreeAdd(repoPath, path, headRef, defaultBranch, { existingBranch: true });
    return path;
  }

  const branch = worktreeBranch(issue);
  if (await branchExists(repoPath, branch)) {
    // Branch survives but its worktree was removed → re-attach without -b.
    await worktreeAdd(repoPath, path, branch, defaultBranch, { existingBranch: true });
    return path;
  }

  // New branch off the local default branch's current commit (no fetch).
  if (!(await branchExists(repoPath, defaultBranch))) {
    throw new Error(`cannot resolve default branch "${defaultBranch}" (no commits?)`);
  }
  await worktreeAdd(repoPath, path, branch, defaultBranch);
  return path;
}
