import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
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
    permissions: { defaultMode: "auto" },
  });
  return { json, allowedDomains };
}

// ---- interactive launch args ----
//
// Build the `claude` argv for the interactive dev session. Auto mode is coupled to the sandbox:
// `--permission-mode auto` is added only when managed sandbox settings are present (i.e.
// `--sandbox`). Without the sandbox there is no managed-settings, so the session starts in
// Claude's normal approval mode — never unattended auto-run without the sandbox guard rails.
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
// sandbox nor auto mode ever took effect.) Centralized here so the verbose `exec:` line and the
// real spawn share one source of truth.
// Parse the `lh dev` positional target. Two accepted forms:
//   <id>                  e.g. "116"            → { id: 116 }            (repo from cwd/--repo)
//   <owner>/<repo>/<id>   e.g. "jugyo/lh/116"   → { repo: "jugyo/lh", id: 116 }
// The owner/repo/id form lets `lh dev` start from outside the target repo's working directory
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
  const args = ["--session-id", sessionId];
  if (managedSettings) {
    // Sandbox present → opt into auto mode explicitly.
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

// ---- kani terminal launch (pure) ----
//
// `lh dev --kani` relaunches the dev loop in a fresh kani terminal instead of the foreground,
// mirroring the /lh-dev-kani skill. The inner `lh dev` runs *without* --kani, so it provisions
// the worktree and spawns claude itself; --kani is deliberately not forwarded, which prevents
// infinite recursion. Everything here is a pure argv/string builder so it can be unit-tested
// without spawning anything (same approach as buildClaudeArgs / formatLaunchPlan).

// Single-quote a value for the shell command string handed to kani. Even though --repo/--allow
// are validated upstream, quote defensively so the pure builder is safe on any input.
function shArg(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

// Flags forwarded to the inner `lh dev`. --kani is intentionally absent (no recursion).
export interface KaniForwardFlags {
  repo?: string;
  sandbox?: boolean;
  allow?: string;
  verbose?: boolean;
}

export interface KaniLaunch {
  command: string; // inner shell command: `lh dev <n> <forwarded flags>`
  cwd: string; // main checkout root (repo local_path) the inner `lh dev` resolves from
  name: string; // terminal display name: `#<n> <title>` (control chars stripped)
  argv: string[]; // full argv for spawnSync("kani", argv)
}

export function buildKaniLaunch({
  issue,
  title,
  cwd,
  flags,
}: {
  issue: number;
  title: string;
  cwd: string;
  flags: KaniForwardFlags;
}): KaniLaunch {
  // Forward every flag except --kani. Boolean flags are emitted bare; value flags are
  // shell-quoted so a value with spaces/quotes can't break the command string kani runs.
  const parts = ["lh", "dev", String(issue)];
  if (flags.repo) parts.push("--repo", shArg(flags.repo));
  if (flags.sandbox) parts.push("--sandbox");
  if (flags.allow) parts.push("--allow", shArg(flags.allow));
  if (flags.verbose) parts.push("--verbose");
  const command = parts.join(" ");

  // Strip control chars from the title (it reaches the terminal name and shell argv) so a
  // crafted issue title can't inject escape sequences (see display()).
  const name = `#${issue} ${display(title)}`.trim();

  const argv = [
    "launch_terminal",
    "--command",
    command,
    "--cwd",
    cwd,
    "--name",
    name,
  ];
  return { command, cwd, name, argv };
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
  // (e.g. 0x9d) in an attacker-controlled title can't reach a terminal title (kani / claude --name).
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

// `.claude/` (settings.json / settings.local.json) is usually untracked / gitignored, so a
// worktree built from the committed tree lacks it — project/local permission rules go missing
// in the Claude session `lh dev` launches. Mirror it from the primary checkout. Idempotent and
// run on every provision (including worktree reuse) so the copy stays current; skipped silently
// when the primary has no `.claude/`. Untracked at the destination too, so nothing leaks into PRs.
function syncClaudeDir(repoPath: string, worktreePath: string): void {
  const src = join(repoPath, ".claude");
  if (!existsSync(src)) return;
  cpSync(src, join(worktreePath, ".claude"), { recursive: true });
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
  const provisioned = existing.some(
    (w) => canonical(w.path) === canonical(path),
  );

  if (!provisioned) {
    // Path occupied but not a git worktree → refuse to silently overwrite.
    if (existsSync(path)) {
      throw new Error(
        `worktree path exists but is not a git worktree: ${path}`,
      );
    }

    mkdirSync(dirname(path), { recursive: true });

    if (headRef) {
      // PR (kind=pull): no new branch — check out the existing head branch.
      await worktreeAdd(repoPath, path, headRef, defaultBranch, {
        existingBranch: true,
      });
    } else {
      const branch = worktreeBranch(issue);
      if (await branchExists(repoPath, branch)) {
        // Branch survives but its worktree was removed → re-attach without -b.
        await worktreeAdd(repoPath, path, branch, defaultBranch, {
          existingBranch: true,
        });
      } else {
        // New branch off the local default branch's current commit (no fetch).
        if (!(await branchExists(repoPath, defaultBranch))) {
          throw new Error(
            `cannot resolve default branch "${defaultBranch}" (no commits?)`,
          );
        }
        await worktreeAdd(repoPath, path, branch, defaultBranch);
      }
    }
  }

  // Sync on every provision so reused worktrees pick up the latest settings too.
  syncClaudeDir(repoPath, path);
  return path;
}
