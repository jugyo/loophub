import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { branchExists, worktreeAdd, worktreeList } from "../core/git.ts";

// `lh dev` provisions an isolated git worktree (outside the sandbox) and launches an
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
  sessionName,
}: {
  sessionId: string;
  managedSettings?: string;
  slashCommand: string;
  // Display name for the session picker / terminal title (e.g. `#54 <issue title>`). Stripped
  // of control characters before it reaches argv (see display()) so a crafted issue title can
  // never inject escape sequences into the spawned terminal.
  sessionName?: string;
}): string[] {
  const args = ["--session-id", sessionId, "--permission-mode", "acceptEdits"];
  if (sessionName) {
    const name = display(sessionName).trim();
    if (name) args.push("--name", name);
  }
  if (managedSettings) {
    args.push("--managed-settings", managedSettings);
  }
  args.push(slashCommand);
  return args;
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
  // backspace, …) — a bare \r or \b can still overwrite the rendered line on its own.
  return stripVTControlCharacters(v).replace(/[\x00-\x1f\x7f]/g, "");
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
export function worktreePath(
  worktreeRoot: string,
  fullName: string,
  issue: number,
): string {
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
export async function provisionWorktree(
  input: ProvisionInput,
): Promise<string> {
  const { repoPath, fullName, defaultBranch, worktreeRoot, issue, headRef } =
    input;
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
    await worktreeAdd(repoPath, path, headRef, defaultBranch, {
      existingBranch: true,
    });
    return path;
  }

  const branch = worktreeBranch(issue);
  if (await branchExists(repoPath, branch)) {
    // Branch survives but its worktree was removed → re-attach without -b.
    await worktreeAdd(repoPath, path, branch, defaultBranch, {
      existingBranch: true,
    });
    return path;
  }

  // New branch off the local default branch's current commit (no fetch).
  if (!(await branchExists(repoPath, defaultBranch))) {
    throw new Error(
      `cannot resolve default branch "${defaultBranch}" (no commits?)`,
    );
  }
  await worktreeAdd(repoPath, path, branch, defaultBranch);
  return path;
}
